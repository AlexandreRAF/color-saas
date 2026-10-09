"""Build a safe, unified BASF catalog. PyArrow is needed only for this import."""

import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile


def clean(value):
    return ' '.join(str(value or '').split())


def build(source, destination):
    import pyarrow.feather as feather

    files = sorted(source.glob('*.feather'))

    if not files:
        raise ValueError(f'No Feather files in {source}')

    destination.parent.mkdir(parents=True, exist_ok=True)

    descriptor, temporary = tempfile.mkstemp(prefix='.basf-', suffix='.db', dir=destination.parent)

    os.close(descriptor)

    count = 0

    # Regional exports can put supplier references such as VW-2013 in the
    # Color Code column. Resolve their make prefix locally, but expose a code
    # only if the unprefixed value exists in that maker's OEM catalog.
    tables = {file: feather.read_table(file) for file in files}
    makers, oem_codes = {}, {}

    for file, table in tables.items():
        if not table.num_rows:
            continue

        first = table.slice(0, 1).to_pylist()[0]
        maker = clean(first.get('Manufacturer'))
        makers[file.stem] = maker

        if maker != 'SOUTH AMERICA':
            oem_codes.setdefault(maker, set()).update(clean(value).upper()
                for value in table['Color Code'].to_pylist() if clean(value))

    sanitized = 0

    try:
        with sqlite3.connect(temporary) as db:
            db.execute('''CREATE TABLE paint_codes (
                id INTEGER PRIMARY KEY, description TEXT NOT NULL,
                manufacturer TEXT NOT NULL, universal_code TEXT NOT NULL,
                year TEXT NOT NULL, year_start INTEGER, year_end INTEGER,
                source_file TEXT NOT NULL, source_row INTEGER NOT NULL)''')

            db.execute('CREATE TABLE import_files (name TEXT PRIMARY KEY, rows INTEGER NOT NULL)')

            for file in files:
                table = tables[file]
                required = {'Manufacturer', 'Color Name', 'Color Code', 'Year'}

                if table.num_rows and not required.issubset(table.column_names):
                    raise ValueError(f'Unexpected columns in {file.name}')

                rows = []

                # Allowlist only: Std. No./Std, Aux Code and Color Finder never
                # enter SQLite. Color Code contains the OEM code (N3S, 040, etc.).
                for index, row in enumerate(table.select(sorted(required)).to_pylist() if table.num_rows else []):
                    year = clean(row['Year'])
                    years = [int(y) for y in re.findall(r'\b(?:18|19|20)\d{2}\b', year)]
                    start, end = (min(years), max(years)) if years else (None, None)

                    if year.startswith(('-', '–')):
                        start = None

                    if year.endswith(('-', '–')):
                        end = None

                    maker, code = clean(row['Manufacturer']), clean(row['Color Code'])

                    if maker == 'SOUTH AMERICA':
                        prefix, separator, value = code.partition('-')
                        maker = makers.get(prefix, maker)
                        code = value if separator and value.upper() in oem_codes.get(maker, set()) else ''
                        sanitized += 1

                    rows.append((clean(row['Color Name']), maker, code,
                                 year, start, end, file.name, index + 1))

                db.executemany('''INSERT INTO paint_codes
                    (description, manufacturer, universal_code, year, year_start, year_end, source_file, source_row)
                    VALUES (?,?,?,?,?,?,?,?)''', rows)

                db.execute('INSERT INTO import_files VALUES (?,?)', (file.name, len(rows)))

                count += len(rows)

            if not count:
                raise ValueError('BASF catalog is empty')

            db.execute('CREATE INDEX paint_code ON paint_codes(manufacturer, universal_code)')
            db.execute('CREATE INDEX paint_name ON paint_codes(description)')

            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('BASF database integrity check failed')

        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

    return {'database': str(destination), 'files': len(files), 'rows': count,
            'regional_references_sanitized': sanitized}


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument('--source', type=Path, default=root / 'extracted_data')
    parser.add_argument('--output', type=Path, default=root / 'basf.db')

    args = parser.parse_args()

    print(json.dumps(build(args.source, args.output)))

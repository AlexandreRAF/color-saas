"""Unify model Feather exports, excluding BASF formula/supplier identifiers."""

import argparse
import json
import os
import sqlite3
import tempfile
from pathlib import Path

from model_catalog import manufacturer_key, normalized, year_bounds


def clean(value):
    return ' '.join(str(value or '').split())


def build(source, destination):
    import pyarrow.feather as feather

    files = sorted(source.glob('*.feather'))
    if not files:
        raise ValueError(f'No Feather files in {source}')

    required = ['Manufacturer', 'Model', 'Color Name', 'Color Code', 'Year']
    # Read only allowed fields. Std/Std. No., Aux Code and Color Finder never
    # enter SQLite, debug artifacts or model prompts. Color Class is empty here.
    tables = []
    native_codes = {}
    for file in files:
        table = feather.read_table(file)
        if table.num_rows and not set(required).issubset(table.column_names):
            raise ValueError(f'Unexpected columns in {file.name}')
        rows = table.select(required).to_pylist() if table.num_rows else []
        tables.append((file, rows))
        for row in rows:
            maker = clean(row['Manufacturer'])
            code = clean(row['Color Code'])
            # Regional supplier references use an export/make prefix. Treat
            # those as unsafe until independently found as an OEM value.
            if file.stem != 'SA' and not code.startswith(file.stem + '-'):
                native_codes.setdefault(manufacturer_key(maker), set()).add(code.upper())

    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.basf-models-', suffix='.db', dir=destination.parent)
    os.close(descriptor)
    count = withheld = 0

    try:
        with sqlite3.connect(temporary) as db:
            db.execute('''CREATE TABLE model_paints (
                id INTEGER PRIMARY KEY, description TEXT NOT NULL,
                manufacturer TEXT NOT NULL, manufacturer_key TEXT NOT NULL,
                universal_code TEXT NOT NULL, model TEXT NOT NULL, model_key TEXT NOT NULL,
                year TEXT NOT NULL, year_start INTEGER, year_end INTEGER,
                source_file TEXT NOT NULL, source_row INTEGER NOT NULL)''')
            db.execute('CREATE TABLE import_files (name TEXT PRIMARY KEY, rows INTEGER NOT NULL)')

            for file, records in tables:
                rows = []
                for index, row in enumerate(records):
                    maker, model = clean(row['Manufacturer']), clean(row['Model'])
                    code, year = clean(row['Color Code']), clean(row['Year'])
                    if file.stem == 'SA' or code.startswith(file.stem + '-'):
                        _, separator, suffix = code.partition('-')
                        known = native_codes.get(manufacturer_key(maker), set())
                        code = suffix if separator and suffix.upper() in known else ''
                        withheld += not bool(code)
                    start, end = year_bounds(year)
                    rows.append((clean(row['Color Name']), maker, manufacturer_key(maker),
                                 code, model, normalized(model), year, start, end, file.name, index + 1))

                db.executemany('''INSERT INTO model_paints
                    (description, manufacturer, manufacturer_key, universal_code, model,
                    model_key, year, year_start, year_end, source_file, source_row)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)''', rows)
                db.execute('INSERT INTO import_files VALUES (?,?)', (file.name, len(rows)))
                count += len(rows)

            if not count:
                raise ValueError('BASF model catalog is empty')
            db.execute('CREATE INDEX model_identity ON model_paints(manufacturer_key, model_key)')
            db.execute('CREATE INDEX model_code ON model_paints(manufacturer_key, universal_code)')
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Model database integrity check failed')

        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

    return {'database': str(destination), 'files': len(files), 'rows': count,
            'unsafe_codes_withheld': withheld}


if __name__ == '__main__':
    backend = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=backend.parent / 'extracted_data_models')
    parser.add_argument('--output', type=Path, default=backend / 'data' / 'basf_models.db')
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.output)))

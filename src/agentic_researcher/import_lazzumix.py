"""Rebuild the root Lazzumix SQLite database from lazzumix.html."""

import json
import os
import re
import sqlite3
import tempfile
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
HTML_PATH = ROOT / 'lazzumix.html'
DATABASE_PATH = ROOT / 'lazzumix.db'
DETAIL_PATTERN = re.compile(r"alternativa\(['\"]([^'\"]+)['\"]\)")


class LazzumixTableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)

        self.rows = []
        self.row = None
        self.cell_parts = None
        self.detail_id = ''

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)

        if tag == 'tr':
            self.row = []
            self.detail_id = ''
            match = DETAIL_PATTERN.search(attributes.get('onclick', ''))

            if match:
                self.detail_id = match.group(1)
        elif tag == 'td' and self.row is not None:
            self.cell_parts = []

    def handle_data(self, data):
        if self.cell_parts is not None:
            self.cell_parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'td' and self.cell_parts is not None and self.row is not None:
            self.row.append(' '.join(''.join(self.cell_parts).split()))
            self.cell_parts = None
        elif tag == 'tr' and self.row is not None:
            if len(self.row) == 6 and self.detail_id:
                code, universal_code, product_group, description, year, manufacturer = self.row
                self.rows.append((
                    code.strip(), universal_code.strip(), product_group.strip(),
                    description.strip(), year.strip(), manufacturer.strip(), self.detail_id,
                ))

            self.row = None
            self.cell_parts = None
            self.detail_id = ''


def extract_rows():
    source = HTML_PATH.read_bytes().decode('windows-1252', errors='replace')
    parser = LazzumixTableParser()

    parser.feed(source)

    if not parser.rows:
        raise RuntimeError(f'No paint rows found in {HTML_PATH}')

    return parser.rows


def build_database(rows):
    descriptor, temporary_name = tempfile.mkstemp(prefix='.lazzumix-', suffix='.db', dir=ROOT)

    os.close(descriptor)

    try:
        with sqlite3.connect(temporary_name) as connection:
            connection.execute('''
                CREATE TABLE paint_codes (
                    id INTEGER PRIMARY KEY,
                    lazzuril_code TEXT NOT NULL,
                    universal_code TEXT,
                    product_group TEXT,
                    description TEXT,
                    year TEXT,
                    manufacturer TEXT,
                    detail_id TEXT
                )
            ''')

            connection.executemany('''
                INSERT INTO paint_codes (
                    lazzuril_code, universal_code, product_group,
                    description, year, manufacturer, detail_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', rows)

            connection.commit()

            integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]

            if integrity != 'ok':
                raise RuntimeError(f'Database integrity check failed: {integrity}')

        os.replace(temporary_name, DATABASE_PATH)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def main():
    rows = extract_rows()

    build_database(rows)
    print(json.dumps({
        'database': str(DATABASE_PATH),
        'source': str(HTML_PATH),
        'rows': len(rows),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()

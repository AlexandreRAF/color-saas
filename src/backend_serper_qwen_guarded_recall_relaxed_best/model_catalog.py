"""Indexed, read-only access to BASF's model-specific paint records."""

import re
import sqlite3
import unicodedata
from pathlib import Path

from database_code_agent import name_tokens, finish_tags


def normalized(value):
    value = unicodedata.normalize('NFKD', str(value or '')).casefold()
    value = ''.join(char for char in value if not unicodedata.combining(char))
    return ' '.join(re.findall(r'[a-z]+|[0-9]+', value))


def manufacturer_key(value):
    key = normalized(value)
    aliases = {'volkswagen': 'vw', 'general motors': 'gm', 'chevrolet': 'gm',
               'mercedes benz': 'mercedes', 'kia motors': 'kia', 'landrover': 'land rover'}

    # Preserve the original regional manufacturer in every returned record.
    # Only these explicit geographic qualifiers are ignored for retrieval.
    for suffix in (' europe', ' australia', ' usa', ' sa'):
        if key.endswith(suffix):
            key = key[:-len(suffix)]
            break

    return aliases.get(key, key)


def year_bounds(value):
    match = re.fullmatch(r'(\d{4})?\s*[-–]\s*(\d{4})?', value.strip())
    if match:
        return tuple(int(year) if year else None for year in match.groups())
    if re.fullmatch(r'\d{4}', value.strip()):
        year = int(value.strip())
        return year, year
    return None, None


class ModelCatalog:
    def __init__(self, filename):
        self.db = sqlite3.connect(Path(filename).resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        self.db.row_factory = sqlite3.Row
        self.palettes = {}
        self.count = self.db.execute('SELECT count(*) FROM model_paints').fetchone()[0]
        if not self.count:
            raise ValueError('Required BASF model catalog is empty')

    def palette(self, request):
        maker = manufacturer_key(request.get('brand'))
        model = normalized(request.get('model'))
        brand_text = normalized(request.get('brand'))
        if brand_text and model.startswith(brand_text + ' '):
            model = model[len(brand_text) + 1:]
        if not maker or not model:
            return []

        key = (maker, model, request.get('year'))
        if key in self.palettes:
            return self.palettes[key]

        # Token boundaries distinguish Gol/Golf, A3/A30 and S10/S100. Trim or
        # generation qualifiers remain visible and require reviewer assessment.
        rows = self.db.execute('''SELECT id, description, manufacturer, universal_code,
            model, model_key, year, year_start, year_end, source_file, source_row
            FROM model_paints WHERE manufacturer_key = ?
            AND (model_key = ? OR model_key LIKE ?)
            ORDER BY model_key, description, universal_code, year, id''',
            (maker, model, model + ' %')).fetchall()

        output = []
        seen = set()
        for row in rows:
            signature = tuple(row[key] for key in ('description', 'manufacturer', 'model', 'universal_code', 'year'))
            if signature in seen:
                continue
            seen.add(signature)
            year = request.get('year')
            start, end = row['year_start'], row['year_end']
            relation = 'unknown'
            if isinstance(year, int) and start is not None and end is not None:
                relation = 'within_catalog_range' if start <= year <= end else 'outside_catalog_range'

            output.append({
                'candidate_id': -1_000_000_000 - row['id'], 'record_id': row['id'],
                'catalog': 'basf_models', 'description': row['description'],
                'manufacturer': row['manufacturer'], 'universal_code': row['universal_code'],
                'model': row['model'], 'year': row['year'], 'market': None,
                'model_match': 'exact' if row['model_key'] == model else 'qualified_model',
                'year_relation': relation, 'vehicle_year_confirmed': False,
                'source_file': row['source_file'], 'source_row': row['source_row'],
            })

        self.palettes[key] = sorted(output, key=lambda row: (
            row['model_match'] != 'exact', row['year_relation'] != 'within_catalog_range',
            row['year_relation'] == 'outside_catalog_range', row['description']))
        return self.palettes[key]

    def lookup(self, request):
        name = name_tokens(request.get('name', ''))
        codes = {str(code).strip().upper() for code in request.get('source_codes', [])}
        output = []

        for row in self.palette(request):
            tokens = name_tokens(row['description'])
            same_name = bool(name) and tokens == name
            if request.get('exact_name_only') and (not same_name
                    or not finish_tags(request.get('name', '')) <= finish_tags(row['description'])):
                continue
            related_name = bool(name) and set(name).issubset(tokens)
            same_code = bool(row['universal_code']) and row['universal_code'].upper() in codes
            if not (same_name or related_name or same_code):
                continue
            output.append({**row, 'complete_name_match': same_name,
                           'source_code_match': same_code,
                           'name_match': 'all_words' if same_name else 'related_words' if related_name else 'code_only',
                           'finish_descriptions': [row['description']]})

        return output

    def close(self):
        self.db.close()

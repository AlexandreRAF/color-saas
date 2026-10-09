"""Read-only JSONL catalog worker; indexes paint identities and opens model records once per run."""

import json
from pathlib import Path
import sqlite3
import sys
import re
from database_code_agent import name_tokens, finish_tags, words, HUES
from model_catalog import ModelCatalog


def brand(value):
    key = ' '.join(words(value))
    return {'volkswagen': 'vw', 'chevrolet': 'gm', 'general motors': 'gm',
            'kia motors': 'kia', 'mercedes benz': 'mercedes'}.get(key, key)


def code_aliases(value):
    # Comma/slash-separated OEM equivalents are explicit catalog aliases.
    # Hyphens can be intrinsic to a code and must never be split heuristically.
    return {part.strip().upper() for part in re.split(r'[,/;]', value or '') if part.strip()}


def catalog_name_tokens(value, catalog):
    # Lazzumix's parenthesized base/effect layer labels are formula metadata,
    # not paint versions or finish proof. Preserve bare letters, Roman numerals
    # and annotations from other catalogs whose meaning is not established.
    if catalog == 'lazzumix':
        value = re.sub(r'\s*\(\s*[BE]\s*\)(?=\s*(?:/\s*(?:CL|LF|LG|EC|PE|LQ|COL|LC|LT)\s*)*$)',
                       '', value or '', flags=re.I)
    return name_tokens(value)


class Catalogs:
    def __init__(self, lazzumix, basf, models=None):
        self.rows, self.tokens, self.codes, self.identities = [], {}, {}, {}
        self.names = []
        self.counts = {}

        for catalog, file in [('lazzumix', lazzumix), ('basf', basf)]:
            with sqlite3.connect(Path(file).resolve().as_uri() + '?mode=ro', uri=True) as db:
                # Never SELECT *. Only universal/OEM codes may leave the DB.
                rows = db.execute('SELECT id,description,manufacturer,universal_code,year FROM paint_codes').fetchall()

            if not rows:
                raise ValueError(f'Required {catalog} catalog is empty')

            self.counts[catalog] = len(rows)

            for id_, name, maker, code, year in rows:
                index = len(self.rows)
                record = dict(candidate_id=id_ if catalog == 'lazzumix' else -id_,
                              catalog=catalog, description=name or '', manufacturer=maker or '',
                              universal_code=(code or '').strip(), year=str(year or ''))

                self.rows.append(record)
                self.names.append(catalog_name_tokens(name, catalog))

                for token in set(self.names[-1]):
                    self.tokens.setdefault(token, set()).add(index)

                if code and code.strip():
                    for alias in code_aliases(code) | {code.strip().upper()}:
                        self.codes.setdefault(alias, set()).add(index)
                        self.identities.setdefault((brand(maker), alias), set()).add(index)

        self.models = ModelCatalog(models or Path(__file__).parent / 'data' / 'basf_models.db')
        self.counts['basf_models'] = self.models.count

    def lookup(self, request):
        if request.get('operation') == 'model_palette':
            return {'catalogs_queried': ['basf_models'], 'records': self.models.palette(request)}

        tokens = set(name_tokens(request.get('name', '')))
        exact = set.intersection(*(self.tokens.get(t, set()) for t in tokens)) if tokens else set()
        if request.get('exact_name_only'):
            required_finish = finish_tags(request.get('name', ''))
            exact = {i for i in exact if self.names[i] == name_tokens(request.get('name', ''))
                     and required_finish <= finish_tags(self.rows[i]['description'])}
            output = [{**self.rows[i], 'name_match': 'all_words', 'complete_name_match': True,
                       'source_code_match': False, 'finish_descriptions': [self.rows[i]['description']]}
                      for i in sorted(exact) if brand(self.rows[i]['manufacturer']) == brand(request.get('brand', ''))]
            return {'catalogs_queried': list(self.counts),
                    'candidates': output + self.models.lookup(request)}
        anchors = tokens - HUES
        relaxed = set.intersection(*(self.tokens.get(t, set()) for t in anchors)) if anchors else set()
        hues = tokens & HUES

        if hues:
            relaxed = {i for i in relaxed if not (set(self.names[i]) & HUES)
                       or (set(self.names[i]) & hues)}

        observed = {str(c).strip().upper() for c in request.get('source_codes', []) if c}
        coded = set().union(*(self.codes.get(c, set()) for c in observed)) if observed else set()
        maker = brand(request.get('brand', ''))

        # A code collision at an unrelated maker is not a useful retrieval lead
        # when this maker already has that code. Named donor paints still enter
        # through exact/related names and their documented context.
        same_make_codes = {i for i in coded if brand(self.rows[i]['manufacturer']) == maker}

        if same_make_codes:
            coded = same_make_codes

        found = exact | relaxed | coded

        # A Portuguese name can find its English equivalent through the exact
        # manufacturer + COMPLETE OEM code. Codes alone never join makes.
        bridges = set()

        for i in found:
            row = self.rows[i]
            if row['universal_code'] and i in exact:
                for alias in code_aliases(row['universal_code']):
                    bridges.update(self.identities.get((brand(row['manufacturer']), alias), set()))

        found |= bridges

        def score(i):
            row = self.rows[i]
            return (brand(row['manufacturer']) == maker, i in coded, i in exact, i in bridges,
                    bool(row['universal_code']), row['year'] == str(request.get('year', '')))

        output, counts, seen = [], {}, set()

        for i in sorted(found, key=score, reverse=True):
            row = self.rows[i]
            signature = tuple(row[k] for k in ['catalog', 'description', 'manufacturer', 'universal_code', 'year'])
            complete_name = self.names[i] == name_tokens(request.get('name', ''))
            # Never hide an exact-name competing code behind the fuzzy-result
            # limit: deterministic identity checks need the complete code set.
            if signature in seen or (counts.get(row['catalog'], 0) >= 24 and not complete_name):
                continue

            seen.add(signature)

            counts[row['catalog']] = counts.get(row['catalog'], 0) + 1
            linked = {i}

            for alias in code_aliases(row['universal_code']):
                linked.update(self.identities.get((brand(row['manufacturer']), alias), set()))

            descriptions = sorted({self.rows[j]['description'] for j in linked})

            output.append({**row, 'name_match': 'all_words' if i in exact else 'code_bridge' if i in bridges
                           else 'related_words' if i in relaxed else 'code_only',
                           'complete_name_match': complete_name,
                           'source_code_match': i in coded, 'finish_descriptions': descriptions})

        model_rows = self.models.lookup(request)
        return {'catalogs_queried': list(self.counts), 'candidates': output + model_rows}


def main():
    catalogs = Catalogs(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)

    print(json.dumps({'ready': True, 'counts': catalogs.counts}), flush=True)

    for line in sys.stdin:
        request = json.loads(line)

        try:
            response = catalogs.lookup(request)
        except Exception as error:
            response = {'error': str(error)}

        print(json.dumps({'id': request['id'], **response}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}), flush=True)
        sys.exit(1)

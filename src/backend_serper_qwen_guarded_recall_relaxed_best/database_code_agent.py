"""Retrieve paint-name and source-code leads for the final matching agent."""

import json
import re
import sqlite3
import sys
import unicodedata
from difflib import get_close_matches
from functools import lru_cache
from pathlib import Path


FINISH_SUFFIXES = {
    'met', 'metal', 'metalico', 'metalica', 'metallic', 'metallique',
    'metalizado', 'metalizada', 'liso', 'lisa', 'solid', 'solido', 'solida',
    'pearl', 'perla', 'perlado', 'perlada', 'pearlescent', 'prl',
    'fosco', 'fosca', 'matte', 'mate', 'gloss', 'glossy', 'brilhante',
    'satin', 'satinado', 'satinada', 'nacre', 'mica', 'perol', 'perolizado', 'perolizada',
    'm', 'me', 'c', 'ec', 'lf', 'lg', 'cl', 'lq', 'pe', 'col', 'lc', 'lt',
}

VERSION_MARKERS = {'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'}
COLOR_WORD_ALIASES = {
    'prata': 'silver', 'plata': 'silver', 'plateado': 'silver', 'plateada': 'silver',
    'cinza': 'gray', 'gris': 'gray', 'grey': 'gray',
    'branco': 'white', 'branca': 'white', 'blanco': 'white', 'blanca': 'white',
    'preto': 'black', 'preta': 'black', 'negro': 'black', 'negra': 'black',
    'azul': 'blue', 'verde': 'green',
    'vermelho': 'red', 'vermelha': 'red', 'rojo': 'red', 'roja': 'red',
    'amarelo': 'yellow', 'amarela': 'yellow', 'amarillo': 'yellow', 'amarilla': 'yellow',
    'dourado': 'gold', 'dourada': 'gold', 'dorado': 'gold', 'dorada': 'gold', 'oro': 'gold',
    'marrom': 'brown', 'marron': 'brown',
    'slv': 'silver', 'titânio': 'titanium', 'titanio': 'titanium',
    'grigio': 'gray', 'bianco': 'white', 'nero': 'black', 'rosso': 'red',
}

HUES = {'silver', 'gray', 'white', 'black', 'blue', 'green', 'red', 'yellow', 'gold', 'brown'}


def words(value):
    normalized = unicodedata.normalize('NFKD', value or '')
    normalized = ''.join(char for char in normalized if not unicodedata.combining(char))
    return re.findall(r'[a-z0-9]+', normalized.casefold())


def name_tokens(value):
    tokens = words(value)

    while len(tokens) > 1 and tokens[-1] in FINISH_SUFFIXES - VERSION_MARKERS:
        tokens.pop()

    # Normalize known hue translations/spelling variants; shade and version
    # words such as "Sleek" and "II" remain significant.
    return [COLOR_WORD_ALIASES.get(token, token) for token in tokens]


def finish_tags(value):
    tokens = set(words(value))
    categories = {
        'pearl': {'pearl', 'pearlescent', 'perol', 'perolizado', 'perolizada',
                  'prl', 'perla', 'perlado', 'perlada', 'nacre'},
        'solid': {'solid', 'solido', 'solida', 'liso', 'lisa'},
        'metallic': {'metallic', 'metalico', 'metalica', 'metalizado',
                     'metalizada', 'met'},
        'matte': {'matte', 'mate', 'fosco', 'fosca'},
    }
    return {name for name, aliases in categories.items() if tokens & aliases}


def main():
    request = json.loads(sys.argv[1])
    database_path = Path(sys.argv[2]).resolve()
    colors = request.get('colors')

    if not isinstance(colors, list):
        raise ValueError('colors must be a list')

    uri = f'{database_path.as_uri()}?mode=ro'

    with sqlite3.connect(uri, uri=True, timeout=3) as connection:
        rows = connection.execute(
            'SELECT id, description, year, manufacturer, universal_code FROM paint_codes'
        ).fetchall()

    # Normalize each database description once, then intersect whole-word postings.
    # Previously every color normalized every row again (O(colors * rows)).
    token_rows = {}
    code_rows = {}
    code_descriptions = {}

    for index, row in enumerate(rows):
        for token in set(name_tokens(row[1])):
            token_rows.setdefault(token, set()).add(index)

        for code in words(row[4]):
            code_rows.setdefault(code, set()).add(index)

        # Finish evidence stays within the exact manufacturer/code pair. Do not
        # split compound codes or borrow finishes from a similarly named paint.
        if row[4] and row[4].strip():
            key = (row[3].strip().casefold(), row[4].strip().upper())
            code_descriptions.setdefault(key, set()).add(row[1])

    @lru_cache(maxsize=256)

    def spelling_variants(token):
        return [token] + (get_close_matches(token, token_rows.keys(), n=4, cutoff=0.88)
                          if len(token) >= 5 else [])

    results = []

    for color in colors:
        paint_name = color.get('name', '')
        query_tokens = set(name_tokens(paint_name))

        if not query_tokens:
            results.append({'index': color.get('index'), 'candidates': []})
            continue

        # Search by whole output-name words rather than requiring the database
        # description to equal the output exactly. Extra finish/version words
        # remain in the row for the OpenAI matcher to resolve using make/year.
        postings = [token_rows.get(token, set()) for token in query_tokens]
        exact = set.intersection(*postings)

        # Retrieval leads only: allow a missing translated hue or one spelling error
        # in long shade words. The final agent still checks every distinctive word.
        anchors = query_tokens - HUES
        relaxed_postings = []

        for token in anchors:
            variants = spelling_variants(token)
            relaxed_postings.append(set().union(*(token_rows.get(variant, set()) for variant in variants)))

        relaxed = set.intersection(*relaxed_postings) if relaxed_postings else set()
        observed_codes = {token for code in color.get('source_codes', []) for token in words(code)}
        by_code = set().union(*(code_rows.get(code, set()) for code in observed_codes))
        candidates = []

        for index in sorted(exact | relaxed | by_code):
            row = rows[index]

            candidates.append({'candidate_id': row[0], 'description': row[1], 'year': row[2],
                               'manufacturer': row[3], 'universal_code': row[4] or '',
                               'name_match': 'all_words' if index in exact else 'related_words' if index in relaxed else 'code_only',
                               'source_code_match': index in by_code})

            if request.get('include_finish'):
                key = (row[3].strip().casefold(), (row[4] or '').strip().upper())
                candidates[-1]['finish_descriptions'] = sorted(code_descriptions.get(key, {row[1]}))

        results.append({'index': color.get('index'), 'candidates': candidates})

    print(json.dumps({'matches': results}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)

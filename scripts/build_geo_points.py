#!/usr/bin/env python3
"""Resolve the dataset's (city, country) pairs to latitude/longitude.

The CitationHub parquet files name every affiliation's city and country but carry no
coordinates, so the city and affiliation layers of the geographic map have nothing to
plot. This script matches each distinct (affiliation_city, affiliation_country) pair
against the GeoNames gazetteer and writes the result into the repository as static
lookup data:

    backend/data/city_coords.json         city+country -> lat/lon  (served by /api/geo)
    frontend/public/data/geo_points.json  the cities and affiliations that /api/geo
                                          plots, with their counts (client-side
                                          fallback for a backend that predates them)

Affiliations reuse the city coordinates: the dataset locates an affiliation no more
precisely than its city, so every institution in one city shares a point and the map is
what pulls them apart visually.

Run this again whenever the seed parquet is regenerated.

GeoNames inputs (https://download.geonames.org/export/dump/, CC BY 4.0):
    cities500.zip     populated places with population > 500
    countryInfo.txt   ISO country codes and names

Usage:
    python scripts/build_geo_points.py \
        --seed  /path/to/seed_cited_papers_normalized.parquet \
        --geonames /path/to/geonames-download-dir
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent

# The frontend draws a few hundred bubbles at most, so the fallback snapshot keeps only
# the busiest affiliations rather than all ~5,200. Cities are few enough to keep whole.
# Mirrors MAX_AFFILIATION_POINTS in backend/main.py.
FALLBACK_AFFILIATIONS = 800

# GeoNames names countries differently from Scopus in a number of cases, and a few
# Scopus "countries" are territories with their own ISO code.
COUNTRY_ALIASES = {
    "bolivia": "BO",
    "bosnia and herzegovina": "BA",
    "brunei darussalam": "BN",
    "cape verde": "CV",
    "cote d'ivoire": "CI",
    "czech republic": "CZ",
    "czechia": "CZ",
    "east timor": "TL",
    "hong kong": "HK",
    "iran": "IR",
    "laos": "LA",
    "libya": "LY",
    "macao": "MO",
    "macau": "MO",
    "macedonia": "MK",
    "moldova": "MD",
    "netherlands": "NL",
    "north korea": "KP",
    "palestine": "PS",
    "russian federation": "RU",
    "russia": "RU",
    "south korea": "KR",
    "syria": "SY",
    "taiwan": "TW",
    "tanzania": "TZ",
    "the netherlands": "NL",
    "united states": "US",
    "united states of america": "US",
    "usa": "US",
    "united kingdom": "GB",
    "uk": "GB",
    "vatican city": "VA",
    "venezuela": "VE",
    "viet nam": "VN",
    "vietnam": "VN",
}

# Scopus city spellings that GeoNames does not carry even as an alternate name.
CITY_ALIASES = {
    ("US", "washington, d.c."): "washington",
    ("SG", "singapore city"): "singapore",
    ("CN", "xi'an"): "xian",
    ("TW", "taipei city"): "taipei",
}

# Research campuses that sit in settlements too small for the cities500 extract, yet carry
# enough papers to be worth plotting. Coordinates are the campus locations.
MANUAL_COORDS = {
    ("US", "university park"): (40.79820, -77.85990),        # Pennsylvania State University
    ("GB", "hinxton"): (52.08000, 0.18460),                  # Wellcome Genome Campus
    ("US", "mississippi state"): (33.45520, -88.79440),      # Mississippi State University
    ("US", "research triangle park"): (35.89900, -78.86370),
    ("US", "moffett field"): (37.40900, -122.06400),         # NASA Ames Research Center
    ("US", "villanova"): (40.03760, -75.34570),              # Villanova University
    ("DK", "tjele"): (56.43330, 9.58330),                    # Aarhus University, Foulum
}

# Several US university towns share a name with a larger city elsewhere in the country,
# and the dataset records no state. Pin those to the right first-level division; without
# this, population ranking sends e.g. Penn State to Texas and Caltech to Houston.
ADMIN1_OVERRIDES = {
    ("US", "amherst"): "MA",          # University of Massachusetts Amherst
    ("US", "athens"): "GA",           # University of Georgia
    ("US", "columbia"): "MO",         # University of Missouri
    ("US", "corvallis"): "OR",        # Oregon State University
    ("US", "menlo park"): "CA",       # SRI International / SLAC
    ("US", "pasadena"): "CA",         # Caltech
    ("US", "princeton"): "NJ",        # Princeton University
    ("US", "troy"): "NY",             # Rensselaer Polytechnic Institute
    ("US", "university park"): "PA",  # Pennsylvania State University
}


def norm(name: str) -> str:
    """Casefold, strip accents and drop punctuation so spellings compare equal."""
    decomposed = unicodedata.normalize("NFKD", str(name))
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    cleaned = re.sub(r"[^a-z0-9]+", " ", ascii_only.lower())
    return cleaned.strip()


def load_country_codes(country_info: Path) -> dict[str, str]:
    """Map a normalised country name to its ISO 3166-1 alpha-2 code."""
    codes: dict[str, str] = {}
    with country_info.open(encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 5:
                continue
            iso2, name = parts[0], parts[4]
            codes[norm(name)] = iso2
    for alias, iso2 in COUNTRY_ALIASES.items():
        codes[norm(alias)] = iso2
    return codes


Index = dict[tuple[str, str], list[dict]]


def load_geonames(cities_zip: Path) -> tuple[Index, Index]:
    """Index GeoNames places by (country code, normalised name).

    Canonical names and alternate names are kept in separate indexes. Alternate names
    are noisy — Palo Alto lists "University Park", Edison lists "Menlo Park" — so they
    are only consulted when no canonical spelling matches. Within an index, entries are
    ordered most-populous-first.
    """
    canonical: Index = defaultdict(list)
    alternate: Index = defaultdict(list)
    with zipfile.ZipFile(cities_zip) as zf:
        member = next(n for n in zf.namelist() if n.endswith(".txt"))
        with zf.open(member) as raw:
            for line in raw:
                parts = line.decode("utf-8").rstrip("\n").split("\t")
                if len(parts) < 15:
                    continue
                name, asciiname, alternates = parts[1], parts[2], parts[3]
                try:
                    lat, lon = float(parts[4]), float(parts[5])
                except ValueError:
                    continue
                country, admin1 = parts[8], parts[10]
                population = int(parts[14]) if parts[14].isdigit() else 0
                place = {"lat": lat, "lon": lon, "population": population,
                         "name": name, "admin1": admin1}

                for spelling in {name, asciiname}:
                    key = norm(spelling)
                    if key:
                        canonical[(country, key)].append(place)
                for spelling in alternates.split(","):
                    key = norm(spelling)
                    if key:
                        alternate[(country, key)].append(place)

    for index in (canonical, alternate):
        for places in index.values():
            places.sort(key=lambda p: p["population"], reverse=True)
    return canonical, alternate


def resolve(city: str, iso2: str, canonical: Index, alternate: Index) -> dict | None:
    """Find the GeoNames place in `iso2` that best matches `city`."""
    manual = MANUAL_COORDS.get((iso2, norm(city)))
    if manual:
        return {"lat": manual[0], "lon": manual[1], "population": 0,
                "name": city, "admin1": ""}

    spellings = [city]
    alias = CITY_ALIASES.get((iso2, city.lower()))
    if alias:
        spellings.insert(0, alias)
    # Scopus sometimes qualifies a city ("Newcastle upon Tyne", "Frankfurt am Main");
    # the leading token group is a usable last resort.
    for spelling in list(spellings):
        head = re.split(r" (?:upon|am|an|sur|s|on) ", norm(spelling))[0].strip()
        if head and head != norm(spelling):
            spellings.append(head)

    admin1 = ADMIN1_OVERRIDES.get((iso2, norm(city)))
    for index in (canonical, alternate):
        for spelling in spellings:
            places = index.get((iso2, norm(spelling)))
            if not places:
                continue
            if admin1:
                pinned = [p for p in places if p["admin1"] == admin1]
                if pinned:
                    return pinned[0]
                continue
            return places[0]
    return None


def affiliation_points(seed: pd.DataFrame, resolved: list[dict]) -> list[dict]:
    """The busiest affiliations, each placed at the coordinates of its city.

    An affiliation whose city went unresolved is dropped; it has nowhere to sit on the
    map. The city is kept alongside the name so the map can say where a point is.
    """
    coords = {(r["city"], r["country"]): (r["lat"], r["lon"]) for r in resolved}
    named = seed[seed["affilname"].fillna("").str.len() > 0]
    grouped = (named.groupby(["affilname", "affiliation_city", "affiliation_country"])
                    .size().reset_index(name="count")
                    .sort_values("count", ascending=False))

    points: list[dict] = []
    for name, city, country, count in grouped.itertuples(index=False):
        latlon = coords.get((city, country))
        if latlon is None:
            continue
        points.append({"name": name, "city": city, "country": country,
                       "lat": latlon[0], "lon": latlon[1], "count": int(count)})
        if len(points) == FALLBACK_AFFILIATIONS:
            break
    return points


def write_json(path: Path, meta: dict, arrays: dict[str, list[dict]]) -> None:
    """Write `meta` fields plus each named array, one compact record per line.

    Keeping records on their own lines keeps these generated files diffable without
    paying the size of fully indented JSON.
    """
    def dumps(value) -> str:
        return json.dumps(value, ensure_ascii=False)

    blocks = [f"  {dumps(k)}: {dumps(v)}" for k, v in meta.items()]
    for name, records in arrays.items():
        body = ",\n".join(f"    {dumps(r)}" for r in records)
        blocks.append(f"  {dumps(name)}: [\n{body}\n  ]")
    path.write_text("{\n" + ",\n".join(blocks) + "\n}\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", required=True, type=Path,
                        help="path to seed_cited_papers_normalized.parquet")
    parser.add_argument("--geonames", required=True, type=Path,
                        help="directory holding cities500.zip and countryInfo.txt")
    parser.add_argument("--audit", action="store_true",
                        help="list unresolved and loosely-matched cities instead of writing output")
    args = parser.parse_args()

    cities_zip = args.geonames / "cities500.zip"
    country_info = args.geonames / "countryInfo.txt"
    for path in (args.seed, cities_zip, country_info):
        if not path.exists():
            parser.error(f"missing input: {path}")

    seed = pd.read_parquet(
        args.seed, columns=["affilname", "affiliation_city", "affiliation_country"])
    seed = seed.dropna(subset=["affiliation_city", "affiliation_country"])
    seed = seed[(seed["affiliation_city"].str.len() > 0) & (seed["affiliation_country"].str.len() > 0)]
    pairs = (seed.groupby(["affiliation_city", "affiliation_country"])
                 .size().reset_index(name="count")
                 .sort_values("count", ascending=False))

    country_codes = load_country_codes(country_info)
    canonical, alternate = load_geonames(cities_zip)

    resolved: list[dict] = []
    unmatched: list[tuple[str, str, int]] = []
    loose: list[tuple[str, str, int, str]] = []
    for city, country, count in pairs.itertuples(index=False):
        iso2 = country_codes.get(norm(country))
        place = resolve(city, iso2, canonical, alternate) if iso2 else None
        if place is None:
            unmatched.append((city, country, int(count)))
            continue
        if norm(place["name"]) != norm(city):
            loose.append((city, country, int(count), place["name"]))
        resolved.append({
            "city": city,
            "country": country,
            "lat": round(place["lat"], 5),
            "lon": round(place["lon"], 5),
            "count": int(count),
        })

    total_papers = int(pairs["count"].sum())
    matched_papers = sum(r["count"] for r in resolved)
    print(f"pairs        : {len(resolved)} matched / {len(pairs)} total")
    print(f"papers       : {matched_papers} / {total_papers} "
          f"({matched_papers / total_papers:.2%} coverage)")
    if unmatched:
        print(f"unmatched    : {len(unmatched)} pairs, "
              f"{sum(c for _, _, c in unmatched)} papers")
    if loose:
        print(f"loose matches: {len(loose)} pairs resolved to a differently-named place")

    if args.audit:
        print("\n-- unmatched (largest first) --")
        for city, country, count in unmatched:
            print(f"  {count:5d}  {city} / {country}")
        print("\n-- loose matches (largest first) --")
        for city, country, count, name in loose:
            print(f"  {count:5d}  {city} / {country}  ->  {name}")
        return 0

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    provenance = {
        "generated_at": generated_at,
        "generator": "scripts/build_geo_points.py",
        "source": "GeoNames cities500 + countryInfo (https://www.geonames.org, CC BY 4.0)",
        "matched_pairs": len(resolved),
        "total_pairs": int(len(pairs)),
    }

    affiliations = affiliation_points(seed, resolved)

    coords_path = REPO_ROOT / "backend" / "data" / "city_coords.json"
    coords_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(coords_path, provenance,
               {"cities": [{k: r[k] for k in ("city", "country", "lat", "lon")}
                           for r in resolved]})

    # Mirrors the shapes /api/geo returns (hence "name" for whatever the point is called)
    # so the frontend can drop these straight in when a deployed backend predates them.
    fallback_path = REPO_ROOT / "frontend" / "public" / "data" / "geo_points.json"
    fallback_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(fallback_path,
               {**provenance,
                "affiliations_kept": len(affiliations),
                "note": "Static snapshot, used only when /api/geo omits these points."},
               {"cities": [{"name": r["city"], "country": r["country"], "lat": r["lat"],
                            "lon": r["lon"], "count": r["count"]} for r in resolved],
                "affiliations": affiliations})

    print(f"affiliations : {len(affiliations)} kept for the fallback snapshot")
    print(f"wrote        : {coords_path.relative_to(REPO_ROOT)}")
    print(f"wrote        : {fallback_path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

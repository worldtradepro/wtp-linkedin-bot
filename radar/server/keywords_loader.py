"""
keywords_loader.py
Loads positive and negative keywords from keywords.txt
"""

import re
from pathlib import Path


def load_keywords(path: str = "keywords.txt") -> dict[str, list[str]]:
    """
    Parse keywords.txt and return:
    {
        "positive": [...],
        "negative": [...]
    }
    """
    positive, negative = [], []
    current_section = None

    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line == "[positive]":
                current_section = "positive"
            elif line == "[negative]":
                current_section = "negative"
            elif current_section == "positive":
                positive.append(line.lower())
            elif current_section == "negative":
                negative.append(line.lower())

    return {"positive": positive, "negative": negative}


def passes_filter(title: str, summary: str = "", keywords: dict = None) -> tuple[bool, str]:
    """
    Returns (passes: bool, matched_keyword: str)
    Logic:
      1. If title matches any negative keyword → reject
      2. If title+summary matches any positive keyword → accept
      3. Otherwise → reject
    """
    if keywords is None:
        keywords = load_keywords()

    text_title = title.lower()
    text_full  = f"{title} {summary}".lower()

    # Step 1: negative filter on title only
    for kw in keywords["negative"]:
        if kw in text_title:
            return False, f"negative:{kw}"

    # Step 2: positive match on title + summary
    for kw in keywords["positive"]:
        if kw in text_full:
            return True, kw

    return False, ""


if __name__ == "__main__":
    # Quick test
    kw = load_keywords()
    print(f"Positive keywords: {len(kw['positive'])}")
    print(f"Negative keywords: {len(kw['negative'])}")

    tests = [
        ("Saipem awarded EPCI contract for offshore Nigeria", ""),
        ("TotalEnergies announces quarterly results Q3 2024", ""),
        ("Scatec completes feasibility study for 500MW solar in Egypt", ""),
        ("OCP Group launches FEED for new phosphoric acid plant in Morocco", ""),
        ("Bunge expands soybean crushing plant in Brazil", ""),
        ("New CEO appointed at Shell", ""),
        ("Ivanhoe Mines commences DFS for Kamoa-Kakula Phase 4", ""),
    ]

    print("\n=== Filter Test ===")
    for title, summary in tests:
        passes, kw_matched = passes_filter(title, summary, kw)
        status = f"✓ [{kw_matched}]" if passes else f"✗ [{kw_matched}]"
        print(f"  {status:30s} {title}")

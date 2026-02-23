"""
Baseline and Readiness (Forme%) computation logic.

Mirrors the JS implementation in static/js/segment-analyzer.js for testing
and potential backend use. See README "How baseline/readiness is computed".
"""

from typing import Optional

DEFAULT_CONFIG = {
    "z2HrMin": 132,
    "z2HrMax": 138,
    "baselineWindowDays": 120,
    "baselineTopN": 10,
}


def get_ef(effort: dict) -> Optional[float]:
    """EFF (Efficiency Factor) = (NP or Pavg) / HRavg in W/bpm."""
    if effort.get("efficiency") is not None:
        return float(effort["efficiency"])
    hr = effort.get("average_heartrate")
    p = effort.get("normalized_watts") or effort.get("average_watts")
    if hr and hr > 0 and p is not None:
        return float(p) / float(hr)
    return None


def get_power_used(effort: dict):
    """Power used: normalized_watts or average_watts."""
    return effort.get("normalized_watts") or effort.get("average_watts")


def is_z2_strict(effort: dict, config: Optional[dict] = None) -> dict:
    """
    Is effort Z2-strict valid for baseline?
    Rules: HR in [z2HrMin, z2HrMax], HR and power non-null/non-zero.
    """
    config = config or DEFAULT_CONFIG
    hr = effort.get("average_heartrate")
    power = get_power_used(effort)
    if hr is None or hr <= 0 or power is None or power <= 0:
        return {"valid": False}
    hr_min = config.get("z2HrMin", 132)
    hr_max = config.get("z2HrMax", 138)
    if hr < hr_min or hr > hr_max:
        return {"valid": False}
    return {"valid": True}


def median(values: list) -> Optional[float]:
    """Compute median of a list of numbers."""
    if not values:
        return None
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    mid = n // 2
    return sorted_vals[mid] if n % 2 else (sorted_vals[mid - 1] + sorted_vals[mid]) / 2


def compute_baseline(efforts: list, config: Optional[dict] = None) -> dict:
    """
    Baseline = median of top N EFF among Z2-strict-valid efforts in the last windowDays.
    """
    config = config or DEFAULT_CONFIG
    window_days = config.get("baselineWindowDays", 120)
    top_n = config.get("baselineTopN", 10)
    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).strftime("%Y-%m-%d")
    valid = []
    for e in efforts:
        sd = (e.get("start_date") or "")[:10]
        if sd < cutoff:
            continue
        if not is_z2_strict(e, config)["valid"]:
            continue
        ef = get_ef(e)
        if ef is not None and ef > 0:
            valid.append((e, ef))
    if not valid:
        return {"baseline": None, "count": 0, "efforts": []}
    valid.sort(key=lambda x: x[1], reverse=True)
    top = [ef for _, ef in valid[:top_n]]
    return {
        "baseline": median(top),
        "count": len(top),
        "efforts": [e for e, _ in valid[:top_n]],
    }


def compute_readiness(effort_ef: Optional[float], baseline: Optional[float]) -> Optional[dict]:
    """
    Forme% = (EFF_today / baseline - 1) * 100
    ΔEFF = EFF_today - baseline
    """
    if baseline is None or baseline <= 0 or effort_ef is None or effort_ef <= 0:
        return None
    forme_pct = round((effort_ef / baseline - 1) * 1000) / 10
    delta_ef = round((effort_ef - baseline) * 1000) / 1000
    return {"formePct": forme_pct, "deltaEF": delta_ef}

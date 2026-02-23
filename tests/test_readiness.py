"""Unit tests for baseline and readiness (Forme%) computation."""

from datetime import datetime, timedelta, timezone
from readiness import (
    median,
    get_ef,
    is_z2_strict,
    compute_baseline,
    compute_readiness,
    DEFAULT_CONFIG,
)


class TestMedian:
    def test_empty(self):
        assert median([]) is None

    def test_single(self):
        assert median([5]) == 5

    def test_odd_length(self):
        assert median([1, 3, 5, 7, 9]) == 5

    def test_even_length(self):
        assert median([1, 3, 5, 7]) == 4  # (3+5)/2

    def test_unsorted(self):
        assert median([9, 1, 5, 3, 7]) == 5


class TestIsZ2Strict:
    def test_valid_z2(self):
        e = {"average_heartrate": 135, "average_watts": 250}
        assert is_z2_strict(e)["valid"] is True

    def test_hr_too_low(self):
        e = {"average_heartrate": 130, "average_watts": 250}
        assert is_z2_strict(e)["valid"] is False

    def test_hr_too_high(self):
        e = {"average_heartrate": 140, "average_watts": 250}
        assert is_z2_strict(e)["valid"] is False

    def test_null_hr(self):
        e = {"average_heartrate": None, "average_watts": 250}
        assert is_z2_strict(e)["valid"] is False

    def test_zero_hr(self):
        e = {"average_heartrate": 0, "average_watts": 250}
        assert is_z2_strict(e)["valid"] is False

    def test_null_power(self):
        e = {"average_heartrate": 135}
        assert is_z2_strict(e)["valid"] is False

    def test_zero_power(self):
        e = {"average_heartrate": 135, "average_watts": 0}
        assert is_z2_strict(e)["valid"] is False

    def test_uses_normalized_watts(self):
        e = {"average_heartrate": 135, "normalized_watts": 260, "average_watts": 250}
        assert is_z2_strict(e)["valid"] is True
        assert get_ef(e) == 260 / 135

    def test_boundary_min(self):
        e = {"average_heartrate": 132, "average_watts": 250}
        assert is_z2_strict(e)["valid"] is True

    def test_boundary_max(self):
        e = {"average_heartrate": 138, "average_watts": 250}
        assert is_z2_strict(e)["valid"] is True

    def test_custom_config(self):
        e = {"average_heartrate": 140, "average_watts": 250}
        assert is_z2_strict(e, {"z2HrMin": 135, "z2HrMax": 145})["valid"] is True


class TestComputeBaseline:
    def _effort(self, start_date: str, hr: float, watts: float) -> dict:
        return {
            "start_date": start_date,
            "average_heartrate": hr,
            "average_watts": watts,
            "normalized_watts": watts,
        }

    def test_empty_efforts(self):
        r = compute_baseline([])
        assert r["baseline"] is None
        assert r["count"] == 0

    def test_no_z2_valid(self):
        efforts = [
            self._effort("2025-02-01T10:00:00Z", 150, 300),  # HR out of range
            self._effort("2025-02-02T10:00:00Z", 130, 250),  # HR too low
        ]
        r = compute_baseline(efforts)
        assert r["baseline"] is None
        assert r["count"] == 0

    def test_baseline_selection(self):
        today = datetime.now(timezone.utc)
        efforts = []
        for i in range(15):
            d = (today - timedelta(days=i)).strftime("%Y-%m-%d") + "T10:00:00Z"
            watts = 250 + i * 2  # i=0→250W, i=14→278W
            efforts.append(self._effort(d, 135, watts))
        r = compute_baseline(efforts, {"baselineWindowDays": 30, "baselineTopN": 10})
        assert r["baseline"] is not None
        assert r["count"] == 10
        # Top 10 EFF = highest watts = 260..278 (i=5..14)
        top_effs = [(250 + (5 + i) * 2) / 135 for i in range(10)]
        expected = median(top_effs)
        assert abs(r["baseline"] - expected) < 0.001

    def test_window_excludes_old(self):
        now = datetime.now(timezone.utc)
        old = (now - timedelta(days=150)).strftime("%Y-%m-%d") + "T10:00:00Z"
        recent = (now - timedelta(days=5)).strftime("%Y-%m-%d") + "T10:00:00Z"
        efforts = [
            self._effort(old, 135, 250),
            self._effort(recent, 135, 250),
        ]
        r = compute_baseline(efforts, {"baselineWindowDays": 120, "baselineTopN": 10})
        assert r["count"] == 1
        assert r["baseline"] == 250 / 135

    def test_fewer_than_n_uses_all(self):
        recent = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d") + "T10:00:00Z"
        efforts = [
            self._effort(recent, 135, 250),
            self._effort(recent, 134, 240),
        ]
        r = compute_baseline(efforts, {"baselineWindowDays": 120, "baselineTopN": 10})
        assert r["count"] == 2
        assert r["baseline"] == median([250 / 135, 240 / 134])


class TestComputeReadiness:
    def test_null_baseline(self):
        assert compute_readiness(1.9, None) is None

    def test_null_effort_ef(self):
        assert compute_readiness(None, 1.85) is None

    def test_zero_baseline(self):
        assert compute_readiness(1.9, 0) is None

    def test_forme_positive(self):
        # EFF today 1.9, baseline 1.85 -> (1.9/1.85 - 1)*100 ≈ 2.70%
        r = compute_readiness(1.9, 1.85)
        assert r is not None
        assert r["formePct"] == 2.7
        assert r["deltaEF"] == 0.05

    def test_forme_negative(self):
        r = compute_readiness(1.8, 1.85)
        assert r is not None
        assert r["formePct"] == -2.7
        assert r["deltaEF"] == -0.05

    def test_forme_zero(self):
        r = compute_readiness(1.85, 1.85)
        assert r is not None
        assert r["formePct"] == 0
        assert r["deltaEF"] == 0

    def test_rounding(self):
        r = compute_readiness(1.851, 1.85)
        assert r["formePct"] == 0.1
        r2 = compute_readiness(1.849, 1.85)
        assert r2["formePct"] == -0.1

from typing import List

def get_average_heatmap_value(start: float, end: float, heatmap: List[dict]) -> float:
    """Calculates the average retention score from the heatmap for a transcript time segment."""
    if not heatmap:
        return 0.0

    weighted_sum = 0.0
    covered_seconds = 0.0
    max_point_width = 0.0

    for point in heatmap:
        try:
            p_start = float(point.get('start_time', 0.0))
            p_end = float(point.get('end_time', 0.0))
            p_val = float(point.get('value', 0.0))
        except (TypeError, ValueError):
            continue
        if p_end < p_start:
            continue
        max_point_width = max(max_point_width, p_end - p_start)

        # Weight each overlap by its real duration so finer-grained regions
        # don't dominate the score.
        overlap = min(end, p_end) - max(start, p_start)
        if overlap > 0:
            weighted_sum += p_val * overlap
            covered_seconds += overlap

    if covered_seconds > 0:
        return weighted_sum / covered_seconds

    # No overlap: only fall back to the nearest point if it's genuinely close.
    # Beyond one point-width the score is unknown — report 0 instead of inventing one.
    if max_point_width <= 0:
        return 0.0

    mid_time = (start + end) / 2.0
    closest_val = 0.0
    min_dist = float('inf')
    for point in heatmap:
        try:
            p_mid = (float(point.get('start_time', 0.0)) + float(point.get('end_time', 0.0))) / 2.0
            p_val = float(point.get('value', 0.0))
        except (TypeError, ValueError):
            continue
        dist = abs(p_mid - mid_time)
        if dist < min_dist:
            min_dist = dist
            closest_val = p_val

    return closest_val if min_dist <= max_point_width else 0.0

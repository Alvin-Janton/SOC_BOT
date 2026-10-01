"""Print local Parquet rows without modifying files or contacting AWS.

Install dependencies: python -m pip install pandas pyarrow
Usage: python glue/test/parquet_analysis.py --files "path/part-00000.parquet" "path/part-00001.parquet"

Files must share column names and Pandas dtypes. All rows and column values
are displayed without truncation; use small samples that fit in memory.
"""

import argparse
from pathlib import Path
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import pandas as pd


def load_table(paths: list[Path]) -> "pd.DataFrame":
    """Combine compatible local files and stably sort by event_time if present."""
    import pandas as pd

    frames = []
    for path in paths:

        if not path.is_file():
            raise ValueError(f"Not a readable local file: {path}")

        try:
            frame = pd.read_parquet(path, engine="pyarrow")

        except ImportError:
            raise

        except Exception as error:
            raise ValueError(f"Cannot read Parquet file {path}: {error}") from error

        if not frame.columns.is_unique:
            raise ValueError(f"Duplicate column names in {path}")

        if frames:
            reference = frames[0]
            if set(frame.columns) != set(reference.columns):
                raise ValueError(f"Incompatible columns in {path}; expected those in {paths[0]}")

            frame = frame.reindex(columns=reference.columns)

            if not frame.dtypes.equals(reference.dtypes):
                raise ValueError(f"Incompatible column types in {path}; expected those in {paths[0]}")

        frames.append(frame)

    combined = pd.concat(frames, ignore_index=True)
    if "event_time" in combined.columns:
        try:
            combined = combined.sort_values("event_time", kind="stable", na_position="last")
        except (TypeError, ValueError) as error:
            raise ValueError(f"Cannot sort event_time values: {error}") from error
    return combined


def main() -> int:
    """Read the requested local files and print every row and column to stdout."""
    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument(
        "--files", type=Path, nargs="+", required=True,
        help="One or more local Parquet files, combined in the supplied order.",
    )

    args = parser.parse_args()

    try:
        table = load_table(args.files)
        print(table.to_string(index=False, max_rows=None, max_cols=None, max_colwidth=None))
        ordering = "sorted by event_time" if "event_time" in table.columns else "in input order"
        print(f"\n{len(table)} rows from {len(args.files)} files ({ordering}).")

    except ImportError:
        print(
            "Parquet analysis requires pandas and pyarrow. Install with: "
            "python -m pip install pandas pyarrow", file=sys.stderr,
        )
        return 1

    except (OSError, ValueError, TypeError) as error:
        print(f"Parquet analysis failed: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

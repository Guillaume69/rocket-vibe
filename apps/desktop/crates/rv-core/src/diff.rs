//! Turns a list refresh into splices, so a list view keeps its scroll
//! position and its widgets when a message lands or an older page loads.

/// `Splice { at, remove, insert }` replaces `remove` items at `at` with
/// `insert` (indices into the new list). Applied in order, they turn `old`
/// into `new`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Splice {
    pub at: usize,
    pub remove: usize,
    pub insert: std::ops::Range<usize>,
}

/// Both lists sorted by the same strict order (`before`), keys unique.
/// Items with the same key but different content are replaced in place.
pub fn diff_sorted<T, K: PartialEq>(
    old: &[T],
    new: &[T],
    key: impl Fn(&T) -> K,
    before: impl Fn(&T, &T) -> bool,
    same: impl Fn(&T, &T) -> bool,
) -> Vec<Splice> {
    let mut out: Vec<Splice> = Vec::new();
    let mut push = |at: usize, remove: usize, insert: std::ops::Range<usize>| {
        if let Some(last) = out.last_mut() {
            let last_end = last.at + last.insert.len();
            if last_end == at && last.insert.end == insert.start {
                last.remove += remove;
                last.insert.end = insert.end;
                return;
            }
        }
        out.push(Splice { at, remove, insert });
    };

    // `at` is a position in the list as it is being transformed.
    let (mut i, mut j) = (0, 0);
    while i < old.len() || j < new.len() {
        let at = j;
        if j == new.len() {
            push(at, old.len() - i, j..j);
            break;
        }
        if i == old.len() {
            push(at, 0, j..new.len());
            break;
        }
        let (o, n) = (&old[i], &new[j]);
        if key(o) == key(n) {
            if !same(o, n) {
                push(at, 1, j..j + 1);
            }
            i += 1;
            j += 1;
        } else if before(o, n) {
            push(at, 1, j..j);
            i += 1;
        } else {
            push(at, 0, j..j + 1);
            j += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    type Row = (i64, &'static str, &'static str);

    fn apply(old: &[Row], new: &[Row]) -> (Vec<Row>, Vec<Splice>) {
        let splices = diff_sorted(old, new, |r| (r.0, r.1), |a, b| (a.0, a.1) < (b.0, b.1), |a, b| a == b);
        let mut list = old.to_vec();
        for s in &splices {
            list.splice(s.at..s.at + s.remove, new[s.insert.clone()].iter().copied());
        }
        (list, splices)
    }

    #[test]
    fn new_message_is_one_insertion_at_the_end() {
        let old = [(10, "a", ""), (20, "b", "")];
        let new = [(10, "a", ""), (20, "b", ""), (30, "c", "")];
        let (list, splices) = apply(&old, &new);
        assert_eq!(list, new);
        assert_eq!(splices, [Splice { at: 2, remove: 0, insert: 2..3 }]);
    }

    #[test]
    fn older_page_is_one_insertion_at_the_start() {
        let old = [(30, "c", "")];
        let new = [(10, "a", ""), (20, "b", ""), (30, "c", "")];
        let (list, splices) = apply(&old, &new);
        assert_eq!(list, new);
        assert_eq!(splices, [Splice { at: 0, remove: 0, insert: 0..2 }]);
    }

    #[test]
    fn edit_is_an_in_place_replacement() {
        let old = [(10, "a", ""), (20, "b", "")];
        let new = [(10, "a", ""), (20, "b", "edited")];
        let (list, splices) = apply(&old, &new);
        assert_eq!(list, new);
        assert_eq!(splices, [Splice { at: 1, remove: 1, insert: 1..2 }]);
    }

    #[test]
    fn deletion_and_server_timestamp_move() {
        let old = [(10, "a", ""), (20, "b", ""), (30, "c", ""), (50, "opt", "")];
        let new = [(10, "a", ""), (25, "opt", ""), (30, "c", "")];
        assert_eq!(apply(&old, &new).0, new);
    }

    #[test]
    fn emptying_and_filling() {
        let rows = [(10, "a", ""), (20, "b", "")];
        assert!(apply(&rows, &[]).0.is_empty());
        assert_eq!(apply(&[], &rows).0, rows);
        assert!(apply(&rows, &rows).1.is_empty());
    }
}

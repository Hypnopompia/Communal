/**
 * Rule inheritance (HANDOFF §6), shared by the hub (filtering) and the uploader (its own
 * re-check) so the two can never disagree. Rule paths are files (`S/a.jpg`) or folders
 * (`S/sub/`, trailing slash). The governing rule for a path is its own, else the nearest
 * ancestor folder's, else none — meaning "only me".
 */
export function governingRule(rulePaths: ReadonlySet<string>, path: string): string | null {
  if (rulePaths.has(path)) return path;
  let end = path.endsWith('/') ? path.length - 1 : path.length;
  for (;;) {
    const i = path.lastIndexOf('/', end - 1);
    if (i < 0) return null;
    const dir = path.slice(0, i + 1);
    if (rulePaths.has(dir)) return dir;
    end = i;
  }
}

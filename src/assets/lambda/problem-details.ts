/** The media type of an RFC 9457 problem details object. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * An RFC 9457 problem details object. `type` is left out, which means `about:blank`:
 * no meaning beyond the HTTP status, so `title` is that status's standard phrase.
 */
export interface ProblemDetails {
  readonly title: string;
  readonly status: number;
  readonly detail: string;
}

/** The JSON body of a problem, as a string, e.g. for an API Gateway mapping template. */
export function problemJson(problem: ProblemDetails): string {
  return JSON.stringify({ title: problem.title, status: problem.status, detail: problem.detail });
}

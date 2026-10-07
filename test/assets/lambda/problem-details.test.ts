import { PROBLEM_CONTENT_TYPE, problemJson } from '../../../src/assets/lambda/problem-details';

describe('problemJson', () => {
  it('has the standard members title, status and detail, and no type', () => {
    const problem = JSON.parse(problemJson({ title: 'Not Found', status: 404, detail: 'Gone.' }));

    expect(problem).toEqual({ title: 'Not Found', status: 404, detail: 'Gone.' });
    expect(problem).not.toHaveProperty('type');
  });

  it('is served as application/problem+json', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
  });
});

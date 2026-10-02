// Runs before every test file. Blocks all real network calls so tests can
// never reach the JWT Pizza Factory, even by accident. A test that needs a
// factory response overrides this with its own jest.spyOn(global, "fetch").
beforeEach(() => {
  jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    throw new Error(
      `Unmocked fetch to ${url}. Tests must not call the real factory.`,
    );
  });
});

// Undo every spy (fetch guard, DB spies) so call counts don't leak between tests
afterEach(() => {
  jest.restoreAllMocks();
});

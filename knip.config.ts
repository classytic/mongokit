import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  project: ['src/**/*.ts'],
  // Compile-time StandardRepo conformance check — no runtime importers by design.
  ignore: ['src/contract.ts'],
  rules: {
    // `Repository` is exported both named and default, deliberately, so hosts can
    // use either import style. Knip has no narrower way to bless one named+default
    // pair, so the rule is off rather than the finding suppressed file-by-file.
    //
    // `types` is deliberately NOT off. It was, and it hid six dead type exports
    // — including a second `SortSpec` that gave the package two different public
    // types under one name depending on the import path.
    duplicates: 'off',
  },
};

export default config;

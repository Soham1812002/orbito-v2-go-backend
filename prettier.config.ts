import type { Config } from 'prettier';

export default {
  singleQuote: true,
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  trailingComma: 'all',
  bracketSpacing: true,
  endOfLine: 'lf',
  singleAttributePerLine: true,
  plugins: ['prettier-plugin-ejs'],
  overrides: [{ files: '*.ejs', options: { parser: 'html', htmlWhitespaceSensitivity: 'ignore' } }],
} satisfies Config;

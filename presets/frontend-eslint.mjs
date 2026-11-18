// Shared ESLint flat-config rules enforcing accessible names, keyboard-reachable
// interactions, translated user-facing text and unique JSON locale keys.

export const accessibleTemplateSelectors = [
  {
    selector: "VElement[name='img']:not(:has(VAttribute[key.name='alt'], VAttribute[key.argument.name='alt']))",
    message: 'Images must provide an accessible alt or :alt attribute.',
  },
  {
    selector: "VElement[name='button']:not(:has(VText[value=/\\S/], VExpressionContainer, VElement)):not(:has(VAttribute[key.name='aria-label'], VAttribute[key.argument.name='aria-label'], VAttribute[key.name='aria-labelledby'], VAttribute[key.argument.name='aria-labelledby'], VAttribute[key.name='title'], VAttribute[key.argument.name='title']))",
    message: 'Buttons without visible content must provide aria-label, aria-labelledby, or title.',
  },
  {
    selector: "VElement[name=/^(?:div|span)$/]:has(VAttribute[directive=true][key.name.name='on'][key.argument.name='click']):not(:has(VAttribute[key.name='role'], VAttribute[key.argument.name='role'])):not(:has(VAttribute[key.name='tabindex'], VAttribute[key.argument.name='tabindex']))",
    message: 'Use a native <button>/<a> or provide role, tabindex and keyboard handlers for clickable elements.',
  },
];

export const cjkLiteralSelector = {
  selector: 'Literal[value=/[\\u4e00-\\u9fff]/]',
  message: 'Use a locale message key for user-facing text instead of hardcoded Chinese literals.',
};

export function createFrontendCheckPreset({ vueFiles = ['src/**/*.vue'], ignoreRawPattern = '^[0-9\\s/·:]*$' } = {}) {
  return [
    {
      rules: {
        '@intlify/vue-i18n/no-raw-text': [
          'error',
          {
            attributes: {
              '/.*/': ['title', 'description', 'sub-title', 'aria-label', 'placeholder', 'alt'],
            },
            ignorePattern: ignoreRawPattern,
          },
        ],
        '@intlify/vue-i18n/valid-message-syntax': 'error',
        'jsonc/no-dupe-keys': 'error',
      },
    },
    {
      files: vueFiles,
      rules: {
        'no-restricted-syntax': ['error', cjkLiteralSelector, ...accessibleTemplateSelectors],
      },
    },
  ];
}

export default createFrontendCheckPreset;

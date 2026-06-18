import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { LANGUAGE_STORAGE_KEY } from '../i18n/language';
import { LanguageSelect } from './LanguageSelect';

vi.mock('./Select', () => ({
  Select: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('not-a-language')}>Bad language</button>
  ),
}));

describe('<LanguageSelect> unsupported values', () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage('en');
  });

  it('ignores values outside the supported language preferences', async () => {
    const user = userEvent.setup();
    render(<LanguageSelect />);

    await user.click(screen.getByRole('button', { name: 'Bad language' }));

    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    expect(i18n.language).toBe('en');
  });
});

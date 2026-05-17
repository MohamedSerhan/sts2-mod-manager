import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach } from 'vitest';
import i18n from '../i18n';
import { LANGUAGE_STORAGE_KEY } from '../i18n/language';
import { LanguageSelect } from './LanguageSelect';

describe('<LanguageSelect>', () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage('en');
  });

  it('renders Auto, English, and Simplified Chinese choices', () => {
    render(<LanguageSelect />);

    expect(screen.getByLabelText('Language')).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'Auto' })).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'English' })).toHaveValue('en');
    expect(screen.getByRole('option', { name: 'Simplified Chinese' })).toHaveValue('zh-Hans');
  });

  it('persists a manual override and changes i18n language', async () => {
    const user = userEvent.setup();
    render(<LanguageSelect />);

    await user.selectOptions(screen.getByLabelText('Language'), 'zh-Hans');

    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-Hans');
    expect(i18n.language).toBe('zh-Hans');
  });
});

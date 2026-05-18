import { fireEvent, render, screen } from '@testing-library/react';
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

  it('uses the non-compact wrapper class by default', () => {
    const { container } = render(<LanguageSelect />);

    // The wrapping <div> drives layout: the `compact` modifier makes the
    // selector squeeze into header strips, so the default render MUST NOT
    // include it.
    const wrapper = container.querySelector('.gf-language-select');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toBe('gf-language-select');
  });

  it('adds the compact modifier class when compact is true', () => {
    const { container } = render(<LanguageSelect compact />);

    // The compact variant ships with extra spacing/sizing rules in CSS;
    // the modifier class is the contract between the component and the
    // stylesheet.
    const wrapper = container.querySelector('.gf-language-select');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toBe('gf-language-select compact');
  });

  it('ignores change events with unsupported language values', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'zh-Hans');

    render(<LanguageSelect />);
    // Use the role lookup so the test does not depend on the localised
    // label text — the active language could be English or zh-Hans here.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('zh-Hans');
    const englishBefore = i18n.language;

    // Synthesise a change to an unsupported value — the production guard
    // (`if (!isSupportedLanguagePreference(value)) return`) should refuse
    // to persist anything or switch i18n, even if a future bug somehow
    // injects an extra <option>.
    fireEvent.change(select, { target: { value: 'french' } });

    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-Hans');
    expect(i18n.language).toBe(englishBefore);
  });

  it('initialises from a previously saved preference in localStorage', () => {
    // A user who picked Simplified Chinese on a prior visit should see
    // the dropdown reflect that choice the next time the component
    // mounts — not the "auto" default.
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'zh-Hans');

    render(<LanguageSelect />);

    expect(screen.getByLabelText('Language')).toHaveValue('zh-Hans');
  });
});

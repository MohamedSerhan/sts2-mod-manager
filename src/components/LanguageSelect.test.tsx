import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach } from 'vitest';
import i18n from '../i18n';
import { LANGUAGE_STORAGE_KEY } from '../i18n/language';
import { LanguageSelect } from './LanguageSelect';
import { chooseOption, openSelect } from '../__test__/selectHelpers';

describe('<LanguageSelect>', () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage('en');
  });

  it('renders Auto, English, and Simplified Chinese choices', async () => {
    const user = userEvent.setup();
    render(<LanguageSelect />);

    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('Auto');
    const listbox = await openSelect(user, 'Language');
    expect(within(listbox).getByRole('option', { name: 'Auto' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'English' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Simplified Chinese' })).toBeInTheDocument();
  });

  it('persists a manual override and changes i18n language', async () => {
    const user = userEvent.setup();
    render(<LanguageSelect />);

    await chooseOption(user, 'Language', 'Simplified Chinese');

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

  it('initialises from a previously saved preference in localStorage', () => {
    // A user who picked Simplified Chinese on a prior visit should see
    // the dropdown reflect that choice the next time the component
    // mounts — not the "auto" default.
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'zh-Hans');

    render(<LanguageSelect />);

    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('Simplified Chinese');
  });
});

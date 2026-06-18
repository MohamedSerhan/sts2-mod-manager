import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from '../theme/ThemeContext';
import { THEME_STORAGE_KEY } from '../theme/theme';
import { ThemeSelect } from './ThemeSelect';
import { chooseOption, openSelect } from '../__test__/selectHelpers';

function renderSelect() {
  return render(<ThemeProvider><ThemeSelect /></ThemeProvider>);
}

describe('<ThemeSelect>', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('renders Auto, Dark, and Light choices, defaulting to Dark', async () => {
    const user = userEvent.setup();
    renderSelect();
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveTextContent('Dark');
    const listbox = await openSelect(user, 'Theme');
    expect(within(listbox).getByRole('option', { name: 'Auto' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Dark' })).toBeInTheDocument();
    expect(within(listbox).getByRole('option', { name: 'Light' })).toBeInTheDocument();
  });

  it('persists a switch to Light and applies data-theme', async () => {
    const user = userEvent.setup();
    renderSelect();
    await chooseOption(user, 'Theme', 'Light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

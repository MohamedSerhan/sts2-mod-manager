import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { HelpView } from './Help';
import { AllProviders } from '../__test__/providers';
import { resetTauriMocks } from '../__test__/setup';

/**
 * The Help view is intentionally Tauri-free (pure i18n + local state),
 * so these tests cover structure and FAQ open/close behaviour. The 8
 * FAQ topics are part of the v1.7 product spec — we lock them in by
 * name so future cleanup can't silently drop one.
 */

function renderHelp() {
  return render(
    <AllProviders>
      <HelpView onGoToSettings={() => {}} />
    </AllProviders>,
  );
}

describe('<HelpView>', () => {
  beforeEach(() => {
    resetTauriMocks();
  });

  it('renders the Help heading and subtitle', () => {
    renderHelp();
    expect(
      screen.getByRole('heading', { level: 1, name: /^help$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/quick answers and step-by-step guides/i),
    ).toBeInTheDocument();
  });

  it('renders Player quick start with 4 steps', () => {
    renderHelp();
    const heading = screen.getByRole('heading', { name: /playing modpacks/i });
    const card = heading.closest('.gf-card');
    expect(card).not.toBeNull();
    const steps = within(card as HTMLElement).getAllByRole('listitem');
    expect(steps).toHaveLength(4);
  });

  it('renders Creator quick start with 5 steps', () => {
    renderHelp();
    const heading = screen.getByRole('heading', { name: /making modpacks/i });
    const card = heading.closest('.gf-card');
    expect(card).not.toBeNull();
    const steps = within(card as HTMLElement).getAllByRole('listitem');
    expect(steps).toHaveLength(5);
  });

  it('renders all 8 FAQ items with the spec question texts', () => {
    renderHelp();
    const faqQuestions = [
      /what is a modpack and why do i need one/i,
      /what does 'stored' mean for a mod/i,
      /why do i need github to share a modpack/i,
      /why is this mod update blocked/i,
      /what does 'freeze' do/i,
      /what does 'skip this update' do/i,
      /why must i download some mods from nexus manually/i,
      /why isn't every installed mod in my published modpack/i,
    ];
    for (const matcher of faqQuestions) {
      expect(
        screen.getByRole('button', { name: matcher }),
      ).toBeInTheDocument();
    }
    // And: no other FAQ buttons besides those 8. The buttons live
    // inside .gf-faq, so count those explicitly to catch accidental
    // duplicates.
    expect(document.querySelectorAll('.gf-faq .gf-faq-q')).toHaveLength(8);
  });

  it('FAQ item expands its answer on click and collapses on a second click', () => {
    renderHelp();
    const btn = screen.getByRole('button', { name: /what is a modpack/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByText(/a modpack is a saved set of mods/i),
    ).not.toBeInTheDocument();

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText(/a modpack is a saved set of mods/i),
    ).toBeInTheDocument();

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByText(/a modpack is a saved set of mods/i),
    ).not.toBeInTheDocument();
  });

  it('GitHub FAQ explains the share-time GitHub requirement', () => {
    renderHelp();
    const btn = screen.getByRole('button', {
      name: /why do i need github to share a modpack/i,
    });
    fireEvent.click(btn);
    expect(
      screen.getByText(/small public github repository/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your friends never need a github account/i),
    ).toBeInTheDocument();
  });
});

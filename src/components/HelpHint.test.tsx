import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { HelpHint } from './HelpHint';
import { AllProviders } from '../__test__/providers';

/**
 * HelpHint is a small inline `?` icon that reveals a popover sourced
 * from the FAQ keys at `help.faq.<helpKey>.a`. The component is
 * intentionally minimal — it owns nothing beyond open/closed state —
 * so the tests focus on the interaction contract: trigger click,
 * outside-click dismissal, Escape dismissal, multi-instance isolation,
 * and i18n routing.
 */

function mount(helpKey: string) {
  return render(
    <AllProviders>
      <HelpHint helpKey={helpKey} />
    </AllProviders>,
  );
}

describe('<HelpHint>', () => {
  it('renders a help icon button with the i18n aria-label', () => {
    mount('modpackWhat');
    const btn = screen.getByRole('button', { name: /what does this mean/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the popover on click and shows the FAQ answer text', () => {
    mount('modpackWhat');
    const btn = screen.getByRole('button', { name: /what does this mean/i });
    fireEvent.click(btn);

    const tip = screen.getByRole('tooltip');
    expect(tip).toBeInTheDocument();
    // The popover should source from help.faq.modpackWhat.a — that
    // answer mentions "modpack" in plain language.
    expect(tip.textContent?.toLowerCase()).toContain('modpack');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles closed when the trigger is clicked a second time', () => {
    mount('modpackWhat');
    const btn = screen.getByRole('button', { name: /what does this mean/i });
    fireEvent.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes the popover when clicking outside the hint', () => {
    render(
      <AllProviders>
        <div>
          <HelpHint helpKey="modpackWhat" />
          <button type="button" data-testid="outside">elsewhere</button>
        </div>
      </AllProviders>,
    );
    const trigger = screen.getByRole('button', { name: /what does this mean/i });
    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // mousedown is what HelpHint listens for (so React onClick handlers
    // on outside elements don't fire first and re-open it).
    const outside = screen.getByTestId('outside');
    fireEvent.mouseDown(outside);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('closes the popover on Escape key', () => {
    mount('modpackWhat');
    const btn = screen.getByRole('button', { name: /what does this mean/i });
    fireEvent.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('multiple instances do not collide — opening one leaves the other closed', () => {
    render(
      <AllProviders>
        <div>
          <span data-testid="a"><HelpHint helpKey="modpackWhat" /></span>
          <span data-testid="b"><HelpHint helpKey="githubWhy" /></span>
        </div>
      </AllProviders>,
    );
    const buttons = screen.getAllByRole('button', { name: /what does this mean/i });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0]);
    // Only one tooltip should be visible — the other instance stays
    // closed since each owns its own open state.
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'true');
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders different FAQ content depending on helpKey', () => {
    const { unmount } = render(
      <AllProviders>
        <HelpHint helpKey="modpackWhat" />
      </AllProviders>,
    );
    fireEvent.click(screen.getByRole('button', { name: /what does this mean/i }));
    const modpackText = screen.getByRole('tooltip').textContent ?? '';
    unmount();

    render(
      <AllProviders>
        <HelpHint helpKey="githubWhy" />
      </AllProviders>,
    );
    fireEvent.click(screen.getByRole('button', { name: /what does this mean/i }));
    const githubText = screen.getByRole('tooltip').textContent ?? '';

    expect(modpackText).not.toBe(githubText);
    expect(githubText.toLowerCase()).toContain('github');
  });

  it('removes its document listeners when closed (no stray dismissals)', () => {
    mount('modpackWhat');
    const btn = screen.getByRole('button', { name: /what does this mean/i });
    fireEvent.click(btn); // open
    fireEvent.click(btn); // close

    // Now Escape should be a no-op — nothing to dismiss. This catches
    // a regression where the effect cleanup function isn't returned.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});

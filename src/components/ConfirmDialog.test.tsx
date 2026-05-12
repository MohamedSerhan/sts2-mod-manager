import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConfirmProvider, useConfirm, type ConfirmResult } from './ConfirmDialog';

/**
 * Tests for the promise-based confirm dialog. The component returns a
 * Promise that resolves with `{ confirmed: true, checked: boolean }`
 * on accept, or `false` on cancel. We drive it through a tiny inline
 * Trigger component that exposes the resolved value to the test.
 */

function makeHarness() {
  let resolvedWith: ConfirmResult | typeof PENDING = PENDING;
  let triggerOpts: Parameters<ReturnType<typeof useConfirm>>[0] | null = null;

  function Trigger({ optsFactory }: { optsFactory: () => Parameters<ReturnType<typeof useConfirm>>[0] }) {
    const confirm = useConfirm();
    async function go() {
      triggerOpts = optsFactory();
      const result = await confirm(triggerOpts);
      resolvedWith = result;
    }
    return <button onClick={go}>open</button>;
  }

  return {
    Trigger,
    getResolved: () => resolvedWith,
    getOpts: () => triggerOpts,
  };
}

const PENDING = Symbol('pending');

describe('<ConfirmProvider> + useConfirm', () => {
  it('renders the dialog when confirm() is called and resolves true with checked=false on Confirm', async () => {
    const { Trigger, getResolved } = makeHarness();
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <Trigger optsFactory={() => ({ title: 'Apply update?' })} />
      </ConfirmProvider>,
    );

    await user.click(screen.getByText('open'));
    expect(screen.getByText('Apply update?')).toBeInTheDocument();

    // Default confirm label for non-destructive prompt is "Confirm".
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(getResolved()).toEqual({ confirmed: true, checked: false });
  });

  it('resolves to false on Cancel', async () => {
    const { Trigger, getResolved } = makeHarness();
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <Trigger optsFactory={() => ({ title: 'Discard?' })} />
      </ConfirmProvider>,
    );
    await user.click(screen.getByText('open'));
    // Two buttons match "Cancel" (the footer's text button + the X
    // close button which has title="Cancel"). The footer button has
    // the visible text node "Cancel" directly inside it; query by
    // text and then locate the closest button to disambiguate.
    const footerCancel = screen
      .getAllByRole('button', { name: 'Cancel' })
      .find((b) => b.className.includes('gf-btn-3') && !b.className.includes('gf-btn-icon'))!;
    await user.click(footerCancel);
    expect(getResolved()).toBe(false);
  });

  it('resolves to false when the user clicks the X close button', async () => {
    const { Trigger, getResolved } = makeHarness();
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <Trigger optsFactory={() => ({ title: 'Discard?' })} />
      </ConfirmProvider>,
    );
    await user.click(screen.getByText('open'));
    // The X has title="Cancel" — there are two buttons with that role,
    // but only one is identified by title.
    const xs = screen.getAllByTitle('Cancel');
    await user.click(xs[0]);
    expect(getResolved()).toBe(false);
  });

  it('uses the destructive label "Delete" by default when destructive=true', async () => {
    const { Trigger } = makeHarness();
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <Trigger
          optsFactory={() => ({
            title: 'Delete profile?',
            destructive: true,
          })}
        />
      </ConfirmProvider>,
    );
    await user.click(screen.getByText('open'));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('uses confirmLabel when supplied', async () => {
    const { Trigger } = makeHarness();
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <Trigger
          optsFactory={() => ({
            title: 'Big action?',
            confirmLabel: 'Do it',
          })}
        />
      </ConfirmProvider>,
    );
    await user.click(screen.getByText('open'));
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
  });

  it('disables Confirm until the typed phrase matches', async () => {
    const { Trigger, getResolved } = makeHarness();
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <Trigger
          optsFactory={() => ({
            title: 'Wipe mods?',
            destructive: true,
            typedPhrase: 'wipe',
            confirmLabel: 'Wipe',
          })}
        />
      </ConfirmProvider>,
    );
    await user.click(screen.getByText('open'));
    const wipeBtn = screen.getByRole('button', { name: 'Wipe' });
    expect(wipeBtn).toBeDisabled();

    // Wrong phrase — button still disabled
    const input = screen.getByPlaceholderText('wipe');
    await user.type(input, 'nope');
    expect(wipeBtn).toBeDisabled();

    // Clear and type correct phrase (case-insensitive)
    await user.clear(input);
    await user.type(input, 'WIPE');
    expect(wipeBtn).toBeEnabled();
    await user.click(wipeBtn);
    expect(getResolved()).toMatchObject({ confirmed: true });
  });

  it('returns checked=true when the optional checkbox is set', async () => {
    const { Trigger, getResolved } = makeHarness();
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <Trigger
          optsFactory={() => ({
            title: 'Confirm?',
            checkbox: { label: 'Also wipe' },
          })}
        />
      </ConfirmProvider>,
    );
    await user.click(screen.getByText('open'));
    const cb = screen.getByRole('checkbox');
    expect(cb).not.toBeChecked();
    await user.click(cb);
    expect(cb).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(getResolved()).toEqual({ confirmed: true, checked: true });
  });

  it('honors checkbox.defaultChecked', async () => {
    const { Trigger, getResolved } = makeHarness();
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <Trigger
          optsFactory={() => ({
            title: 'Confirm?',
            checkbox: { label: 'Also wipe', defaultChecked: true },
          })}
        />
      </ConfirmProvider>,
    );
    await user.click(screen.getByText('open'));
    expect(screen.getByRole('checkbox')).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(getResolved()).toEqual({ confirmed: true, checked: true });
  });

  it('throws clearly if useConfirm is used outside a provider', () => {
    const errors: unknown[] = [];
    // React swallows render errors; capture via a try/catch around render.
    const Boom = () => {
      try {
        useConfirm();
      } catch (e) {
        errors.push(e);
      }
      return null;
    };
    // Suppress React error logging for this expected throw.
    const origConsoleError = console.error;
    console.error = () => {};
    try {
      act(() => {
        render(<Boom />);
      });
    } finally {
      console.error = origConsoleError;
    }
    expect(errors.length).toBeGreaterThan(0);
  });
});

/**
 * AdvancedSection tests — verifies the shared disclosure component
 * (1.7.0 T9). Each test starts with a fresh localStorage (the global
 * setup.ts beforeEach already clears it, but we double-clear here so
 * the contract is locally visible).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { AdvancedSection } from './AdvancedSection';
import { AllProviders } from '../__test__/providers';

describe('<AdvancedSection>', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to closed when no localStorage value is present', () => {
    render(
      <AllProviders>
        <AdvancedSection localStorageKey="adv-default-closed">body</AdvancedSection>
      </AllProviders>,
    );
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /advanced/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on click and renders body', () => {
    render(
      <AllProviders>
        <AdvancedSection localStorageKey="adv-open-on-click">body</AdvancedSection>
      </AllProviders>,
    );
    const btn = screen.getByRole('button', { name: /advanced/i });
    fireEvent.click(btn);
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggling open then closed hides the body again', () => {
    render(
      <AllProviders>
        <AdvancedSection localStorageKey="adv-toggle-close" defaultOpen>
          body
        </AdvancedSection>
      </AllProviders>,
    );
    expect(screen.getByText('body')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /advanced/i });
    fireEvent.click(btn);
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('persists open state to localStorage and reads it back on remount', () => {
    const { unmount } = render(
      <AllProviders>
        <AdvancedSection localStorageKey="adv-persist">body</AdvancedSection>
      </AllProviders>,
    );
    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect(localStorage.getItem('adv-persist')).toBe('1');
    unmount();

    render(
      <AllProviders>
        <AdvancedSection localStorageKey="adv-persist">body</AdvancedSection>
      </AllProviders>,
    );
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /advanced/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('persists the closed state explicitly (so defaultOpen can be overridden)', () => {
    const { unmount } = render(
      <AllProviders>
        <AdvancedSection localStorageKey="adv-persist-closed" defaultOpen>
          body
        </AdvancedSection>
      </AllProviders>,
    );
    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect(localStorage.getItem('adv-persist-closed')).toBe('0');
    unmount();

    render(
      <AllProviders>
        <AdvancedSection localStorageKey="adv-persist-closed" defaultOpen>
          body
        </AdvancedSection>
      </AllProviders>,
    );
    // defaultOpen=true must NOT override the persisted '0'.
    expect(screen.queryByText('body')).not.toBeInTheDocument();
  });

  it('honors defaultOpen=true when localStorage is empty', () => {
    render(
      <AllProviders>
        <AdvancedSection localStorageKey="adv-default-open" defaultOpen>
          body
        </AdvancedSection>
      </AllProviders>,
    );
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('uses the custom title prop when provided', () => {
    render(
      <AllProviders>
        <AdvancedSection title="Power user tools" localStorageKey="adv-title">
          body
        </AdvancedSection>
      </AllProviders>,
    );
    expect(
      screen.getByRole('button', { name: /power user tools/i }),
    ).toBeInTheDocument();
  });

  it('survives a Storage.getItem that throws', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function () {
      throw new Error('disabled');
    };
    try {
      render(
        <AllProviders>
          <AdvancedSection localStorageKey="adv-throwing-get" defaultOpen>
            body
          </AdvancedSection>
        </AllProviders>,
      );
      // Falls back to defaultOpen=true since getItem threw.
      expect(screen.getByText('body')).toBeInTheDocument();
    } finally {
      Storage.prototype.getItem = original;
    }
  });

  it('survives a Storage.setItem that throws on toggle', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function () {
      throw new Error('disabled');
    };
    try {
      render(
        <AllProviders>
          <AdvancedSection localStorageKey="adv-throwing-set">body</AdvancedSection>
        </AllProviders>,
      );
      fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
      // Body still appears — write error is swallowed.
      expect(screen.getByText('body')).toBeInTheDocument();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

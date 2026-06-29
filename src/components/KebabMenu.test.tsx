import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KebabDivider, KebabItem, KebabMenu, KebabSection } from './KebabMenu';

const ORIGINAL_INNER_HEIGHT = window.innerHeight;

function makeRect({
  top,
  left = 0,
  width = 0,
  height,
}: {
  top: number;
  left?: number;
  width?: number;
  height: number;
}): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockMenuGeometry({
  triggerTop,
  triggerHeight,
  menuHeight,
  viewportHeight,
}: {
  triggerTop: number;
  triggerHeight: number;
  menuHeight: number;
  viewportHeight: number;
}) {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: viewportHeight,
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.getAttribute('role') === 'menu') {
        return makeRect({
          top: triggerTop + triggerHeight + 4,
          width: 240,
          height: menuHeight,
        });
      }
      if (this instanceof HTMLButtonElement) {
        return makeRect({
          top: triggerTop,
          width: 36,
          height: triggerHeight,
        });
      }
      return makeRect({ top: 0, width: 0, height: 0 });
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: ORIGINAL_INNER_HEIGHT,
  });
});

describe('<KebabMenu>', () => {
  it('renders the trigger button + uses default title "More actions"', () => {
    render(
      <KebabMenu>
        <KebabItem onClick={() => {}}>Pin</KebabItem>
      </KebabMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('overrides title via the title prop', () => {
    render(
      <KebabMenu title="Profile actions">
        <KebabItem onClick={() => {}}>x</KebabItem>
      </KebabMenu>,
    );
    expect(screen.getByRole('button', { name: 'Profile actions' })).toBeInTheDocument();
  });

  it('opens the menu when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem onClick={() => {}}>Pin this mod</KebabItem>
      </KebabMenu>,
    );
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Pin this mod' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the menu below the trigger when there is viewport room', async () => {
    mockMenuGeometry({
      triggerTop: 80,
      triggerHeight: 32,
      menuHeight: 160,
      viewportHeight: 500,
    });
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem onClick={() => {}}>Pin this mod</KebabItem>
      </KebabMenu>,
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));

    const menu = screen.getByRole('menu');
    await waitFor(() => expect(menu).not.toHaveClass('gf-kebab-top'));
    expect(menu).not.toHaveClass('gf-kebab-scrollable');
    expect(menu.style.getPropertyValue('--gf-kebab-max-height')).toBe('');
  });

  it('flips the menu above the trigger near the viewport bottom', async () => {
    mockMenuGeometry({
      triggerTop: 560,
      triggerHeight: 32,
      menuHeight: 160,
      viewportHeight: 620,
    });
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem onClick={() => {}}>Pin this mod</KebabItem>
      </KebabMenu>,
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));

    const menu = screen.getByRole('menu');
    await waitFor(() => expect(menu).toHaveClass('gf-kebab-top'));
    expect(menu).not.toHaveClass('gf-kebab-scrollable');
  });

  it('caps oversized menus to available viewport room and scrolls internally', async () => {
    mockMenuGeometry({
      triggerTop: 24,
      triggerHeight: 32,
      menuHeight: 640,
      viewportHeight: 320,
    });
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem onClick={() => {}}>Pin this mod</KebabItem>
      </KebabMenu>,
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));

    const menu = screen.getByRole('menu');
    await waitFor(() => expect(menu).toHaveClass('gf-kebab-scrollable'));
    expect(menu).not.toHaveClass('gf-kebab-top');
    expect(menu.style.getPropertyValue('--gf-kebab-max-height')).toBe('252px');
  });

  it('elevates the wrapper (gf-kebab-open) only while the menu is open', async () => {
    // Guards issue #162: a row's `.gf-card` does not establish a stacking
    // context, so without lifting the open wrapper's z-index the popover paints
    // behind the next row and its items become unclickable. jsdom can't assert
    // real paint order, so we assert the structural class contract that drives
    // the `.gf-kebab-open { z-index }` CSS rule instead.
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem onClick={() => {}}>Pin</KebabItem>
      </KebabMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    const wrapper = trigger.parentElement as HTMLElement;
    expect(wrapper).toHaveClass('gf-kebab-wrap');
    expect(wrapper).not.toHaveClass('gf-kebab-open');

    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(wrapper).toHaveClass('gf-kebab-open');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(wrapper).not.toHaveClass('gf-kebab-open');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem onClick={() => {}}>X</KebabItem>
      </KebabMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when the user clicks outside the menu', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button>outside</button>
        <KebabMenu>
          <KebabItem onClick={() => {}}>X</KebabItem>
        </KebabMenu>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // mousedown handler attached on the next tick — simulate via click
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on item click + invokes the item handler', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem onClick={onClick}>Run audit</KebabItem>
      </KebabMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Run audit' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('<KebabItem>', () => {
  it('renders the danger class when danger=true', async () => {
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem danger onClick={() => {}}>
          Delete
        </KebabItem>
      </KebabMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('menuitem', { name: 'Delete' });
    expect(item.className).toContain('gf-kebab-danger');
  });

  it('renders the description below the label', async () => {
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem description="Locks the mod's version" onClick={() => {}}>
          Pin this mod
        </KebabItem>
      </KebabMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByText("Locks the mod's version")).toBeInTheDocument();
  });

  it('does NOT fire onClick when disabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabItem disabled onClick={onClick}>
          Pin
        </KebabItem>
      </KebabMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pin' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('<KebabSection> + <KebabDivider>', () => {
  it('renders the optional section head when provided', async () => {
    const user = userEvent.setup();
    render(
      <KebabMenu>
        <KebabSection head="From this install">
          <KebabItem onClick={() => {}}>Snapshot</KebabItem>
        </KebabSection>
        <KebabDivider />
        <KebabSection>
          <KebabItem onClick={() => {}}>Other</KebabItem>
        </KebabSection>
      </KebabMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByText('From this install')).toBeInTheDocument();
    expect(screen.getByText('Snapshot')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
  });
});

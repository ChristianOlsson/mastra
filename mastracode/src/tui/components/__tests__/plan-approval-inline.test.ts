import { visibleWidth } from '@earendil-works/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getClipboardImage: vi.fn(),
  getClipboardText: vi.fn(),
}));

vi.mock('../../../clipboard/index.js', () => ({
  getClipboardImage: mocks.getClipboardImage,
  getClipboardText: mocks.getClipboardText,
}));

import { PlanApprovalInlineComponent, PlanResultComponent } from '../plan-approval-inline.js';

describe('PlanApprovalInlineComponent', () => {
  beforeEach(() => {
    mocks.getClipboardImage.mockReset();
    mocks.getClipboardText.mockReset();
  });

  it('includes a goal option and calls onGoal when selected', () => {
    const onGoal = vi.fn();
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal,
        onReject: vi.fn(),
      },
      {} as any,
    );

    const selectList = (component as any).selectList;
    expect(
      selectList.items.some(
        (item: { value: string; label: string }) => item.value === 'goal' && item.label.includes('Use as /goal'),
      ),
    ).toBe(true);

    (component as any).handleSelection('goal');

    expect(onGoal).toHaveBeenCalledTimes(1);
  });

  it('renders the plan inside a border', () => {
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject: vi.fn(),
      },
      {} as any,
    );

    const rendered = component.render(80).join('\n');

    expect(rendered).toContain('╭');
    expect(rendered).toContain('Build the feature');
    expect(rendered).toContain('╰');
  });

  it('forces a full redraw when entering feedback mode', () => {
    const ui = { requestRender: vi.fn() };
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject: vi.fn(),
      },
      ui as any,
    );

    (component as any).handleSelection('edit');
    component.handleInput('a');
    const rendered = component.render(80).join('\n');

    expect(ui.requestRender).toHaveBeenCalledWith(true);
    expect(rendered).toContain('Provide feedback for revision:');
    expect(rendered).toContain('a');
  });

  it('keeps the submitted plan visible while typing requested-change feedback', () => {
    const ui = { requestRender: vi.fn() };
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature\n\n- Run tests\n- Update docs',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject: vi.fn(),
      },
      ui as any,
    );

    (component as any).handleSelection('edit');
    component.handleInput('a');
    component.handleInput('d');
    component.handleInput('d');
    const lines = component.render(80);
    const planLineIndex = lines.findIndex(line => line.includes('Build the feature'));
    const feedbackPromptIndex = lines.findIndex(line => line.includes('Provide feedback for revision:'));
    const typedFeedbackIndex = lines.findIndex(line => line.includes('add'));

    expect(planLineIndex).toBeGreaterThan(-1);
    expect(feedbackPromptIndex).toBeGreaterThan(planLineIndex);
    expect(typedFeedbackIndex).toBeGreaterThan(feedbackPromptIndex);
  });

  it('keeps long plan lines within the rendered width on narrow terminals', () => {
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: `Build ${'VeryLongPlanToken'.repeat(12)} safely`,
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject: vi.fn(),
      },
      {} as any,
    );

    const width = 42;
    const lines = component.render(width);

    expect(lines.some(line => line.includes('VeryLongPlanToken'))).toBe(true);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('renders requested changes below the plan after feedback is submitted', () => {
    const onReject = vi.fn();
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject,
      },
      {} as any,
    );

    (component as any).handleReject('Add verification steps');
    const lines = component.render(80);
    const planLineIndex = lines.findIndex(line => line.includes('Build the feature'));
    const feedbackLineIndex = lines.findIndex(line => line.includes('Requested changes: Add verification steps'));

    expect(onReject).toHaveBeenCalledWith('Add verification steps');
    expect(planLineIndex).toBeGreaterThan(-1);
    expect(feedbackLineIndex).toBeGreaterThan(planLineIndex);
  });

  it('renders persisted requested changes below the plan', () => {
    const component = new PlanResultComponent({
      title: 'Ship it',
      plan: 'Build the feature',
      isApproved: false,
      feedback: 'Add verification steps',
    });

    const lines = component.render(80);
    const statusIndex = lines.findIndex(line => line.includes('Changes requested'));
    const planLineIndex = lines.findIndex(line => line.includes('Build the feature'));
    const feedbackLineIndex = lines.findIndex(line => line.includes('Requested changes: Add verification steps'));

    expect(statusIndex).toBeGreaterThan(-1);
    expect(planLineIndex).toBeGreaterThan(-1);
    expect(statusIndex).toBeGreaterThan(planLineIndex);
    expect(feedbackLineIndex).toBeGreaterThan(statusIndex);
  });

  it('shows hint text about image paste in feedback mode', () => {
    const ui = { requestRender: vi.fn() };
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject: vi.fn(),
      },
      ui as any,
    );

    (component as any).handleSelection('edit');
    const rendered = component.render(80).join('\n');

    expect(rendered).toContain('Ctrl+V paste image');
  });

  it('handles Ctrl+V image paste in feedback mode', () => {
    const pastedImage = { data: 'base64data', mimeType: 'image/png' };
    mocks.getClipboardImage.mockReturnValue(pastedImage);

    const onReject = vi.fn();
    const ui = { requestRender: vi.fn() };
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject,
      },
      ui as any,
    );

    (component as any).handleSelection('edit');

    // Simulate Ctrl+V paste
    component.handleInput('\x16');

    expect(mocks.getClipboardImage).toHaveBeenCalled();
    expect((component as any).pendingImages).toHaveLength(1);

    // The rendered output should show image indicator
    const rendered = component.render(80).join('\n');
    expect(rendered).toContain('1 image attached');
  });

  it('passes images to onReject when feedback is submitted with pasted images', () => {
    const pastedImage = { data: 'base64data', mimeType: 'image/png' };
    mocks.getClipboardImage.mockReturnValue(pastedImage);

    const onReject = vi.fn();
    const ui = { requestRender: vi.fn() };
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject,
      },
      ui as any,
    );

    (component as any).handleSelection('edit');

    // Paste an image via Ctrl+V
    component.handleInput('\x16');

    // Type feedback and submit
    component.handleInput('f');
    component.handleInput('i');
    component.handleInput('x');
    component.handleInput('\r');

    expect(onReject).toHaveBeenCalledWith('fix', [pastedImage]);
  });

  it('handles bracketed paste image detection in feedback mode', () => {
    const pastedImage = { data: 'clipboard-img', mimeType: 'image/png' };
    mocks.getClipboardImage.mockReturnValue(pastedImage);

    const onReject = vi.fn();
    const ui = { requestRender: vi.fn() };
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject,
      },
      ui as any,
    );

    (component as any).handleSelection('edit');

    // Simulate bracketed paste with empty content (image on clipboard)
    component.handleInput('\x1b[200~\x1b[201~');

    expect(mocks.getClipboardImage).toHaveBeenCalled();
    expect((component as any).pendingImages).toHaveLength(1);
    expect((component as any).pendingImages[0]).toEqual(pastedImage);
  });

  it('shows image count in result when rejected with images', () => {
    const pastedImage = { data: 'base64data', mimeType: 'image/png' };
    mocks.getClipboardImage.mockReturnValue(pastedImage);

    const ui = { requestRender: vi.fn() };
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject: vi.fn(),
      },
      ui as any,
    );

    (component as any).handleSelection('edit');
    // Paste an image
    component.handleInput('\x16');
    // Submit feedback
    component.handleInput('t');
    component.handleInput('e');
    component.handleInput('s');
    component.handleInput('t');
    component.handleInput('\r');

    const lines = component.render(80);
    expect(lines.some(line => line.includes('1 image attached'))).toBe(true);
  });

  it('falls back to text paste via Ctrl+V when no image is on clipboard', () => {
    mocks.getClipboardImage.mockReturnValue(null);
    mocks.getClipboardText.mockReturnValue('pasted text');

    const ui = { requestRender: vi.fn() };
    const component = new PlanApprovalInlineComponent(
      {
        planId: 'plan-1',
        title: 'Ship it',
        plan: 'Build the feature',
        onApprove: vi.fn(),
        onGoal: vi.fn(),
        onReject: vi.fn(),
      },
      ui as any,
    );

    (component as any).handleSelection('edit');
    component.handleInput('\x16');

    expect((component as any).pendingImages).toHaveLength(0);
    // Text should have been pasted into the input
    const rendered = component.render(80).join('\n');
    expect(rendered).toContain('pasted text');
  });
});

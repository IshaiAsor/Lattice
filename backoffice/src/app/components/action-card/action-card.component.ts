import { Component, HostListener, inject, input, output, signal } from '@angular/core';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { DeviceSocketService } from 'src/app/services/device.socket.service';
import { UserActionsService } from 'src/app/services/user.actions.service';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { CameraDisplayComponent } from '../camera-display/camera-display.component';
import { ReceivedBadgeComponent } from '../received-badge/received-badge.component';
import {
  activeTraitValue,
  controllableTraits,
  COLOR_OPTIONS,
  hasTrait,
  iconForAction,
  isCameraAction,
  isTelemetryAction,
  traitIconName,
} from 'src/app/utils/device-type.utils';

// Dial geometry
const CX = 60, CY = 52, R = 36;
const START_ANGLE = 225;
const TOTAL_SWEEP = 270;

function toSvgPt(angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + R * Math.cos(rad), y: CY - R * Math.sin(rad) };
}

/**
 * The single rendering of one device action: header, active-trait control, sensor read-outs,
 * camera frame and trait switcher. Used by the dashboard grid and by the group bottom sheet —
 * both had their own copy before, and the sheet's copy kept falling behind.
 *
 * The card fills whatever slot its owner lays out, but both owners give it the same one
 * (216x188, drag rail on the left) — a group card is a dashboard card, just inside a sheet.
 *
 * The card owns the *control* side (sending state, switching the default trait); live state
 * arrives by the owner mutating the `DeviceActionView` it passed in, which both owners already
 * do from their socket subscriptions.
 */
@Component({
  selector: 'app-action-card',
  standalone: true,
  imports: [SHARED_MATERIAL, CameraDisplayComponent, ReceivedBadgeComponent],
  templateUrl: './action-card.component.html',
  styleUrl: './action-card.component.css',
})
export class ActionCardComponent {
  private socketService = inject(DeviceSocketService);
  private userActionsService = inject(UserActionsService);

  action = input.required<DeviceActionView>();
  /** Group membership is only editable from inside a group, so the menu entry is opt-in. */
  canRemoveFromGroup = input(false);

  rename = output<DeviceActionView>();
  removeFromGroup = output<DeviceActionView>();

  iconForAction = iconForAction;
  hasTrait = hasTrait;
  activeTraitValue = activeTraitValue;
  traitIconName = traitIconName;
  controllableTraits = controllableTraits;
  isTelemetryAction = isTelemetryAction;
  isCameraAction = isCameraAction;
  colorOptions = COLOR_OPTIONS;

  private dialDragging = false;

  /** A read is in flight. Guards the menu entry so a stuck device can't be asked repeatedly. */
  refreshing = signal(false);

  @HostListener('document:pointerup')
  onDocumentPointerUp() { this.dialDragging = false; }

  /**
   * Ask the device what state it is really in (F23.6).
   *
   * Nothing is applied here: the answer arrives the way every state change does, as an
   * action_state_update the owning component folds into this action. The spinner is released on
   * the server's own timeout budget rather than on a response, since a confirming read that found
   * no change produces no state event to wait for.
   */
  refreshState(action: DeviceActionView) {
    if (this.refreshing() || !action.online) return;
    this.refreshing.set(true);
    this.userActionsService.readStateNow(action.id).subscribe({
      next: ({ timeoutMs }) => setTimeout(() => this.refreshing.set(false), timeoutMs),
      error: () => this.refreshing.set(false),
    });
  }

  changeActionState(action: DeviceActionView, actionState: unknown) {
    this.socketService.publishActionState(action.id, String(actionState));
  }

  setDefaultTrait(action: DeviceActionView, traitId: number) {
    action.defaultTraitId = traitId;
    this.userActionsService.setDefaultTrait(action.id, traitId).subscribe();
  }

  // ── Arc dial ────────────────────────────────────────────────────

  dialTrackPath(): string {
    const s = toSvgPt(START_ANGLE);
    const e = toSvgPt(START_ANGLE - TOTAL_SWEEP);
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 1 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  dialActivePath(value: unknown): string {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    if (v <= 0) return '';
    if (v >= 100) return this.dialTrackPath();
    const s = toSvgPt(START_ANGLE);
    const e = toSvgPt(START_ANGLE - (v / 100) * TOTAL_SWEEP);
    const largeArc = (v / 100) * TOTAL_SWEEP > 180 ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  dialThumbPt(value: unknown) {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    return toSvgPt(START_ANGLE - (v / 100) * TOTAL_SWEEP);
  }

  onDialPointerDown(event: PointerEvent, action: DeviceActionView) {
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    this.dialDragging = true;
    this.applyDialEvent(event, action);
  }

  onDialPointerMove(event: PointerEvent, action: DeviceActionView) {
    if (!this.dialDragging) return;
    this.applyDialEvent(event, action);
  }

  private applyDialEvent(event: PointerEvent, action: DeviceActionView) {
    const svg = event.currentTarget as SVGSVGElement;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const sp = pt.matrixTransform(svg.getScreenCTM()!.inverse());

    const dx = sp.x - CX;
    const dy = -(sp.y - CY);
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle < 0) angle += 360;

    let sweep = START_ANGLE - angle;
    if (sweep < 0) sweep += 360;
    if (sweep > TOTAL_SWEEP) sweep = sweep > TOTAL_SWEEP + (360 - TOTAL_SWEEP) / 2 ? 0 : TOTAL_SWEEP;

    const v = Math.round((sweep / TOTAL_SWEEP) * 100);
    action.state = v;
    this.changeActionState(action, String(v));
  }
}

import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin } from 'rxjs';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import {
  BlueprintsService,
  DerivePreview,
  InstanceSummary,
  SlotCandidate,
  SlotMatch,
} from 'src/app/services/blueprints.service';
import { BlueprintDeriveDialogComponent } from '../blueprint-derive-dialog/blueprint-derive-dialog.component';

// The blueprints page (F10.8): what you can set up, and what you already have set up.
//
// The gallery deliberately shows readiness *before* the user commits to anything — a blueprint
// needing a device you don't own is the common case, and finding that out three steps into a
// wizard is the frustrating way to learn it.
@Component({
  selector: 'app-blueprints',
  imports: [SHARED_MATERIAL],
  templateUrl: './blueprints.component.html',
  styleUrl: './blueprints.component.css',
})
export class BlueprintsComponent implements OnInit {
  private blueprints = inject(BlueprintsService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private router = inject(Router);

  available: DerivePreview[] = [];
  setups: InstanceSummary[] = [];
  loading = true;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    forkJoin({
      available: this.blueprints.listDerivable(),
      setups: this.blueprints.listInstances(),
    }).subscribe({
      next: ({ available, setups }) => {
        this.available = available;
        this.setups = setups;
        this.loading = false;
      },
      error: () => (this.loading = false),
    });
  }

  /**
   * Devices a slot can actually take. A device already bound to another setup is listed by the
   * preview but cannot be bound again, so every readiness count here reads free devices only —
   * otherwise a blueprint whose only board is busy would advertise itself as ready.
   */
  freeCandidates(slot: SlotMatch): SlotCandidate[] {
    return slot.candidates.filter((c) => c.free);
  }

  /** A blueprint is ready when every required slot has at least one free matching device. */
  isReady(bp: DerivePreview): boolean {
    return bp.unmet.length === 0;
  }

  /** Slots the user must choose for — several free candidates, so auto-bind can't decide. */
  ambiguousCount(bp: DerivePreview): number {
    return bp.slots.filter((s) => this.freeCandidates(s).length > 1).length;
  }

  readinessText(bp: DerivePreview): string {
    if (!this.isReady(bp)) {
      const names = bp.slots
        .filter((s) => s.required && this.freeCandidates(s).length === 0)
        .map((s) => s.label);
      return `Needs ${names.join(' and ')}`;
    }
    const ambiguous = this.ambiguousCount(bp);
    return ambiguous > 0
      ? `Ready — ${ambiguous} choice${ambiguous > 1 ? 's' : ''} to make`
      : 'Ready to set up';
  }

  derive(bp: DerivePreview): void {
    if (!this.isReady(bp)) return;
    this.dialog
      .open(BlueprintDeriveDialogComponent, {
        width: '560px',
        maxHeight: '90vh',
        panelClass: ['glass-dialog', 'compact-dialog'],
        data: { preview: bp },
      })
      .afterClosed()
      .subscribe((result) => {
        if (!result) return;
        this.snackBar.open(`"${result.name}" is set up`, 'Close', { duration: 3000 });
        void this.router.navigate(['/blueprints', result.instance_id]);
      });
  }

  open(setup: InstanceSummary): void {
    void this.router.navigate(['/blueprints', setup.id]);
  }
}

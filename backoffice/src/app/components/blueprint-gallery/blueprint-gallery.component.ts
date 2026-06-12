import { Component, inject, OnInit, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { BlueprintService } from 'src/app/services/blueprint.service';
import type { Blueprint } from 'src/app/models';

@Component({
  selector: 'app-blueprint-gallery',
  imports: [SHARED_MATERIAL],
  templateUrl: './blueprint-gallery.component.html',
  styleUrl: './blueprint-gallery.component.css',
})
export class BlueprintGalleryComponent implements OnInit {
  private svc   = inject(BlueprintService);
  private snack = inject(MatSnackBar);

  blueprints: Blueprint[] = [];
  selected   = signal<Blueprint | null>(null);
  loading    = true;
  deriving   = signal<number | null>(null);

  ngOnInit(): void {
    this.svc.listPublished().subscribe({
      next:  b => { this.blueprints = b; this.loading = false; },
      error: () => { this.loading = false; },
    });
  }

  view(bp: Blueprint): void {
    if (this.selected()?.id === bp.id) {
      this.selected.set(null);
      return;
    }
    this.svc.getById(bp.id).subscribe(full => this.selected.set(full));
  }

  derive(bp: Blueprint, event: Event): void {
    event.stopPropagation();
    this.deriving.set(bp.id);
    this.svc.derive(bp.id).subscribe({
      next:  () => { this.snack.open(`Blueprint "${bp.name}" applied to your account!`, 'OK', { duration: 3000 }); this.deriving.set(null); },
      error: err => {
        const msg = err?.status === 409 ? 'Already added — this blueprint is already in your account.' : 'Derive failed.';
        this.snack.open(msg, 'OK', { duration: 4000 });
        this.deriving.set(null);
      },
    });
  }
}

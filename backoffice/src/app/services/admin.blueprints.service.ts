import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { forkJoin, map, Observable, of, switchMap } from 'rxjs';
import { apiUrl } from './api.config';

// Admin blueprint authoring (F10.9). The server's authoring surface is a whole-document import
// keyed by `key`: an import replaces the definition and lands it as a draft, and `publish` is the
// gate that validates it and flows the new version into every setup already derived from it.

export interface BlueprintSummary {
  id: number;
  key: string;
  name: string;
  description: string | null;
  version: number;
  status: string;
  slot_count: number;
  instance_count: number;
  updated_at: string;
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

export interface SealedTemplateEntrySummary {
  capability_key: string;
  mqtt_action_name?: string;
  action_label: string;
}

/** A released sealed template plus its entries — the source of every action dropdown. */
export interface SealedTemplateDetail {
  id: number;
  name: string;
  status: string;
  entries: SealedTemplateEntrySummary[];
}

export interface MlModelOption {
  id: number;
  kind: string;
  name: string;
  version: string;
}

@Injectable({ providedIn: 'root' })
export class AdminBlueprintsService {
  private base = `${apiUrl()}/api/admin/blueprints`;
  private http = inject(HttpClient);

  list(): Observable<BlueprintSummary[]> {
    return this.http.get<BlueprintSummary[]>(this.base);
  }

  get(id: number): Observable<unknown> {
    return this.http.get<unknown>(`${this.base}/${id}`);
  }

  /** Idempotent by `key`: re-importing replaces the definition and lands it as a draft. */
  import(doc: unknown): Observable<BlueprintSummary> {
    return this.http.post<BlueprintSummary>(`${this.base}/import`, doc);
  }

  /**
   * Validate the document currently in the form. Persists nothing — validating what is *stored*
   * would report on a version the admin isn't looking at, which reads as a pass on edits that
   * were never checked.
   */
  validate(doc: unknown): Observable<ValidationResult> {
    return this.http.post<ValidationResult>(`${this.base}/validate`, doc);
  }

  /** 400 carries `details[]` — every reason at once, not one per round trip. */
  publish(id: number): Observable<BlueprintSummary> {
    return this.http.post<BlueprintSummary>(`${this.base}/${id}/publish`, {});
  }

  remove(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}`);
  }

  /**
   * Released sealed templates **with their entries**, so a slot's action dropdown can offer the
   * exact `mqtt_action_name`s that slot can address. The list endpoint returns only counts, so
   * each released template is fetched individually — there are a handful of them, and getting the
   * addressing right is the whole reason this screen is a form rather than a text box.
   */
  sealedTemplatesWithEntries(): Observable<SealedTemplateDetail[]> {
    return this.http
      .get<{ id: number; name: string; status: string }[]>(
        `${apiUrl()}/api/admin/catalog/sealed/templates`,
      )
      .pipe(
        switchMap((templates) => {
          const released = templates.filter((t) => t.status === 'released');
          if (released.length === 0) return of([] as SealedTemplateDetail[]);
          return forkJoin(
            released.map((t) =>
              this.http
                .get<SealedTemplateDetail>(`${apiUrl()}/api/admin/catalog/sealed/templates/${t.id}`)
                .pipe(
                  map((full) => ({
                    id: full.id,
                    name: full.name,
                    status: full.status,
                    entries: full.entries ?? [],
                  })),
                ),
            ),
          );
        }),
      );
  }

  /** Models an infer stage can reference, addressed by (kind, name, version) for portability. */
  mlModels(): Observable<MlModelOption[]> {
    return this.http.get<MlModelOption[]>(`${apiUrl()}/api/pipelines/ml-models`);
  }
}

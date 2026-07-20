import { Component, inject, OnInit } from '@angular/core';
import { FormArray, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { SHARED_MATERIAL } from 'src/app/shared-ui';
import { DeviceActionView } from 'src/app/services/device.mgmt.service';
import { CreateSceneDto, ScenesService, SceneView } from 'src/app/services/scenes.service';
import { actionControlType, ActionControlType } from 'src/app/utils/device-type.utils';

export interface SceneEditorData {
  scene: SceneView | null;
  actions: DeviceActionView[];
}

interface MemberFormValue {
  user_device_action_id: number;
  target_state: unknown;
  delay_seconds: number;
}

// Create/edit a scene. Mirrors the rule editor's "then do" list — a scene is that action
// list without the conditions. Saves here rather than returning a DTO so the caller only
// has to reload on `true`.
@Component({
  selector: 'app-scene-editor-dialog',
  standalone: true,
  imports: [...SHARED_MATERIAL],
  templateUrl: './scene-editor-dialog.component.html',
  styleUrl: './scene-editor-dialog.component.css',
})
export class SceneEditorDialogComponent implements OnInit {
  dialogRef = inject(MatDialogRef<SceneEditorDialogComponent>);
  data: SceneEditorData = inject(MAT_DIALOG_DATA);
  private fb = inject(FormBuilder);
  private scenesService = inject(ScenesService);

  form!: FormGroup;
  saving = false;
  error: string | null = null;

  ngOnInit(): void {
    this.form = this.fb.group({
      name: [this.data.scene?.name ?? '', [Validators.required, Validators.maxLength(255)]],
      members: this.fb.array([]),
    });

    for (const m of this.data.scene?.members ?? []) {
      this.addMember({
        user_device_action_id: m.user_device_action_id,
        target_state: m.target_state,
        delay_seconds: m.delay_seconds,
      });
    }
    if (this.membersArray.length === 0) this.addMember();
  }

  get membersArray(): FormArray {
    return this.form.get('members') as FormArray;
  }

  addMember(prefill?: Partial<MemberFormValue>): void {
    this.membersArray.push(
      this.fb.group({
        user_device_action_id: [prefill?.user_device_action_id ?? null, Validators.required],
        target_state: [prefill?.target_state ?? '', Validators.required],
        delay_seconds: [prefill?.delay_seconds ?? 0, [Validators.required, Validators.min(0)]],
      }),
    );
  }

  removeMember(i: number): void {
    this.membersArray.removeAt(i);
  }

  // Target state is trait-specific, so reset it when the chosen action changes.
  onMemberActionChange(i: number): void {
    this.membersArray.at(i).get('target_state')?.setValue('');
  }

  actionLabel(a: DeviceActionView): string {
    return a.deviceName ? `${a.deviceName} · ${a.name}` : a.name;
  }

  getActionControlType(id: number | null | undefined): ActionControlType {
    return actionControlType(this.data.actions.find(a => a.id === id));
  }

  // An action may appear at most once per scene (DB unique constraint), so hide the ones
  // already chosen in other rows.
  availableActions(i: number): DeviceActionView[] {
    const taken = new Set(
      this.membersArray.controls
        .map((c, idx) => (idx === i ? null : c.get('user_device_action_id')?.value))
        .filter((v): v is number => typeof v === 'number'),
    );
    return this.data.actions.filter(a => !taken.has(a.id));
  }

  save(): void {
    if (this.form.invalid || this.membersArray.length === 0) return;
    this.saving = true;
    this.error = null;

    const value = this.form.value as { name: string; members: MemberFormValue[] };
    const dto: CreateSceneDto = {
      name: value.name.trim(),
      sort_order: this.data.scene?.sort_order ?? 0,
      members: value.members.map((m, index) => ({
        user_device_action_id: m.user_device_action_id,
        target_state: String(m.target_state),
        sort_order: index,
        delay_seconds: m.delay_seconds ?? 0,
      })),
    };

    const req = this.data.scene
      ? this.scenesService.updateScene(this.data.scene.id, dto)
      : this.scenesService.createScene(dto);

    req.subscribe({
      next: () => this.dialogRef.close(true),
      error: err => {
        this.saving = false;
        this.error = err?.error?.message ?? 'Could not save the scene.';
      },
    });
  }
}

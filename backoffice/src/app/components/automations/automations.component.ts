import { Component, OnInit, ViewChild, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatTabsModule } from '@angular/material/tabs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RulesComponent } from '../rules/rules.component';
import { PipelinesComponent } from '../pipelines/pipelines.component';

const TAB_NAMES = ['rules', 'pipelines'];

@Component({
  selector: 'app-automations',
  standalone: true,
  imports: [MatTabsModule, MatButtonModule, MatIconModule, RulesComponent, PipelinesComponent],
  templateUrl: './automations.component.html',
  styleUrl: './automations.component.css',
})
export class AutomationsComponent implements OnInit {
  @ViewChild(RulesComponent)     rulesComp?: RulesComponent;
  @ViewChild(PipelinesComponent) pipelinesComp?: PipelinesComponent;

  activeTab = 0;

  private route: ActivatedRoute = inject(ActivatedRoute);
  private router: Router = inject(Router);

  ngOnInit(): void {
    const tab = this.route.snapshot.queryParamMap.get('tab') ?? 'rules';
    this.activeTab = Math.max(0, TAB_NAMES.indexOf(tab));
  }

  onTabChange(index: number): void {
    this.activeTab = index;
    this.router.navigate([], {
      queryParams: { tab: TAB_NAMES[index] ?? 'rules' },
      replaceUrl: true,
    });
  }

  onAdd(): void {
    if (this.activeTab === 0) this.rulesComp?.openEditor();
    else this.pipelinesComp?.openEditor();
  }
}

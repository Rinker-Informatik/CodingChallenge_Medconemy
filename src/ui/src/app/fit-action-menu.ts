import { Directive, ElementRef, inject } from '@angular/core';

@Directive({
  selector: 'details[appFitActionMenu]',
  host: {
    '(toggle)': 'fit()',
    '(document:click)': 'closeOnOutsideClick($event)',
    '(window:resize)': 'fit()',
    '(window:scroll)': 'fit()',
    '[class.menu-above]': 'opensAbove',
    '[style.--menu-space.px]': 'availableSpace',
  },
})
export class FitActionMenu {
  private readonly details = inject<ElementRef<HTMLDetailsElement>>(ElementRef).nativeElement;
  protected opensAbove = false;
  protected availableSpace: number | null = null;

  protected closeOnOutsideClick(event: MouseEvent) {
    if (this.details.open && !event.composedPath().includes(this.details)) {
      this.details.open = false;
    }
  }

  protected fit() {
    if (!this.details.open) return;
    const menu = this.details.querySelector('.action-menu');
    if (!menu) return;
    const margin = 8;
    const anchor = this.details.getBoundingClientRect();
    const above = anchor.top - margin;
    const below = window.innerHeight - anchor.bottom - margin;
    const naturalHeight = menu.scrollHeight + 2;
    this.opensAbove = naturalHeight > below && above > below;
    this.availableSpace = Math.max(0, this.opensAbove ? above : below);
  }
}

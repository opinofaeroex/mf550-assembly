import * as THREE from 'three';

/**
 * Callout — technical-drawing style balloon (item number + label) attached to
 * the centre of a set of components, drawn as HTML over the canvas.
 * Works in the 3D viewer and inside the WebXR DOM overlay.
 */
export class Callout {
  constructor(layer, kind = 'step') {
    this.el = document.createElement('div');
    this.el.className = 'callout' + (kind === 'sel' ? ' sel' : '');
    this.el.innerHTML = '<div class="callout-line"></div><div class="callout-dot"></div><div class="callout-label"><span class="num"></span><span class="txt"></span></div>';
    this.line = this.el.querySelector('.callout-line');
    this.dot = this.el.querySelector('.callout-dot');
    this.label = this.el.querySelector('.callout-label');
    this.num = this.el.querySelector('.num');
    this.txt = this.el.querySelector('.txt');
    layer.appendChild(this.el);
    this.objects = [];
    this.hide();
    this._box = new THREE.Box3();
    this._v = new THREE.Vector3();
  }

  set(objects, num, text) {
    this.objects = objects;
    this.num.textContent = num;
    this.txt.textContent = text;
    this.el.style.opacity = objects.length ? '1' : '0';
  }

  hide() { this.objects = []; this.el.style.opacity = '0'; }

  /** Re-project every frame. */
  update(camera, width, height) {
    if (!this.objects.length) return;
    const box = this._box.makeEmpty();
    for (const o of this.objects) box.expandByObject(o);
    if (box.isEmpty()) return;
    const p = box.getCenter(this._v).project(camera);
    if (p.z > 1 || p.z < -1) { this.el.style.opacity = '0'; return; }
    this.el.style.opacity = '1';
    const x = (p.x * 0.5 + 0.5) * width;
    const y = (-p.y * 0.5 + 0.5) * height;
    // label offset toward the upper side away from the screen centre
    const dx = x < width * 0.5 ? -1 : 1;
    const lx = Math.min(width - 90, Math.max(90, x + dx * 70));
    const ly = Math.max(40, y - 70);
    this.dot.style.transform = `translate(${x}px, ${y}px)`;
    this.dot.style.left = '0'; this.dot.style.top = '0';
    this.label.style.left = `${lx}px`;
    this.label.style.top = `${ly}px`;
    const len = Math.hypot(lx - x, ly - y);
    const ang = Math.atan2(ly - y, lx - x);
    this.line.style.width = `${len}px`;
    this.line.style.transform = `translate(${x}px, ${y - 1}px) rotate(${ang}rad)`;
  }
}

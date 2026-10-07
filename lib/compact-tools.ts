/** Compact native tool shells before layout; leave tool-owned content and self renderers intact. */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";

interface PaddingComponent extends Component { paddingY: number }
interface PaddingLease { descriptor: PropertyDescriptor }

function chatContainer(root?: Component): Container | undefined {
	const seen = new Set<Component>();
	function visit(component: Component): Container | undefined {
		if (seen.has(component)) return undefined;
		seen.add(component);
		const candidate = component as Component & { primary?: boolean; child?: Component; children?: Component[] };
		if (candidate.primary && candidate.child) {
			const children = (candidate.child as Container).children;
			if (Array.isArray(children) && children.length === 3 && children.every((child) => child.constructor === Container)) {
				return children[2] as Container;
			}
		}
		for (const child of candidate.children ?? []) {
			const result = visit(child);
			if (result) return result;
		}
		return undefined;
	}
	return root ? visit(root) : undefined;
}

export function createToolCompactor(): { prepare(root?: Component): void; restore(): void } {
	const leases = new Map<PaddingComponent, PaddingLease>();
	function release(component: PaddingComponent): void {
		const lease = leases.get(component);
		if (!lease) return;
		leases.delete(component);
		if (component.paddingY === 0) {
			Object.defineProperty(component, "paddingY", lease.descriptor);
			component.invalidate();
		}
	}
	return {
		prepare(root) {
			const mounted = new Set<PaddingComponent>();
			for (const entry of chatContainer(root)?.children ?? []) {
				if (!(entry instanceof ToolExecutionComponent)) continue;
				const shells = entry as unknown as { contentBox?: PaddingComponent; contentText?: PaddingComponent };
				for (const shell of [shells.contentBox, shells.contentText]) {
					if (!shell) continue;
					mounted.add(shell);
					if (leases.has(shell) || typeof shell.paddingY !== "number" || shell.paddingY <= 0) continue;
					const descriptor = Object.getOwnPropertyDescriptor(shell, "paddingY");
					if (!descriptor || !("value" in descriptor) || !descriptor.writable) continue;
					leases.set(shell, { descriptor });
					Object.defineProperty(shell, "paddingY", { ...descriptor, value: 0 });
					shell.invalidate();
				}
			}
			for (const shell of leases.keys()) if (!mounted.has(shell)) release(shell);
		},
		restore() {
			for (const shell of leases.keys()) release(shell);
		},
	};
}

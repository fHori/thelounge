// Long-press on touch screens. iOS Safari fires no `contextmenu` on a long
// press, so time it from the touch events; Android fires one, which is
// folded into the same press. Mouse right-clicks keep the browser menu.

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

// Elements with their own long-press behaviour (link menus, nick menus,
// image saving, buttons)
const OWN_MENU_SELECTOR =
	"a, button, img, video, audio, input, textarea, .user, .inline-channel, .toggle-button";

export default function useLongPress(onLongPress: (event: MouseEvent) => void) {
	let timer = 0;
	let startX = 0;
	let startY = 0;
	let pressing = false;
	let fired = false;

	const cancelTimer = () => {
		if (timer) {
			window.clearTimeout(timer);
			timer = 0;
		}
	};

	const fire = (x: number, y: number) => {
		cancelTimer();
		fired = true;
		onLongPress(
			new MouseEvent("contextmenu", {
				clientX: x,
				clientY: y,
				view: window,
				cancelable: true,
			})
		);
	};

	const touchstart = (event: TouchEvent) => {
		cancelTimer();
		fired = false;
		pressing = false;

		const target = event.target as Element | null;

		if (event.touches.length !== 1 || target?.closest?.(OWN_MENU_SELECTOR)) {
			return;
		}

		pressing = true;
		startX = event.touches[0].clientX;
		startY = event.touches[0].clientY;
		timer = window.setTimeout(() => fire(startX, startY), LONG_PRESS_MS);
	};

	const touchmove = (event: TouchEvent) => {
		const touch = event.touches[0];

		if (
			!touch ||
			event.touches.length > 1 ||
			Math.hypot(touch.clientX - startX, touch.clientY - startY) > MOVE_TOLERANCE_PX
		) {
			cancelTimer();
			pressing = false;
		}
	};

	const touchend = (event: TouchEvent) => {
		cancelTimer();
		pressing = false;

		// Keep the lifting finger from clicking (and closing) the menu
		if (fired && event.cancelable) {
			event.preventDefault();
		}
	};

	const contextmenu = (event: MouseEvent) => {
		if (!pressing) {
			return;
		}

		event.preventDefault();

		if (!fired) {
			fire(event.clientX, event.clientY);
		}
	};

	return {
		touchstartPassive: touchstart,
		touchmovePassive: touchmove,
		touchend,
		touchcancel: touchend,
		contextmenu,
	};
}

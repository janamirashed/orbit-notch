import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

export function springStep(t, response, damping) {
    if (t <= 0) return 0;
    const omega0 = (2 * Math.PI) / response;
    if (damping < 1) {

        const omegaD = omega0 * Math.sqrt(1 - damping * damping);
        const decay = Math.exp(-damping * omega0 * t);
        return 1 - decay * (Math.cos(omegaD * t) +
                            (damping * omega0 / omegaD) * Math.sin(omegaD * t));
    }

    const decay = Math.exp(-omega0 * t);
    return 1 - decay * (1 + omega0 * t);
}

export const SPRINGS = {
    open:  { response: 0.40, damping: 0.78, duration: 560 },
    close: { response: 0.38, damping: 0.92, duration: 460 },

    hint:  { response: 0.34, damping: 1.00, duration: 340 },

    peek:  { response: 0.40, damping: 0.88, duration: 500 },
};

export const OrbitSpringAnimator = GObject.registerClass(
class OrbitSpringAnimator extends GObject.Object {
    _init(actor) {
        super._init();
        this._actor = actor;
        this._timeline = null;
    }

    stop() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline.run_dispose();
            this._timeline = null;
        }
    }

    run({ response, damping, duration }, onUpdate, onComplete) {
        this.stop();
        const tl = Clutter.Timeline.new_for_actor(this._actor, duration);
        this._timeline = tl;

        tl.connect('new-frame', (_tl, msec) => {
            onUpdate(springStep(msec / 1000, response, damping));
        });
        tl.connect('completed', () => {
            onUpdate(1);
            this._timeline = null;
            tl.run_dispose();
            if (onComplete) onComplete();
        });
        tl.start();
    }

    get isRunning() {
        return !!this._timeline && this._timeline.is_playing();
    }
});

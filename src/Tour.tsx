import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, usePathname } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import type { Strings } from '@/i18n/en';
import { useI18n } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { elevation, fonts, radii, space, useShadow, useTheme } from '@/theme';
import { Button } from './Button';
import { Txt } from './Txt';
import { openSheets, useKeys } from './useKeys';

// The guided first-run tour (docs/design/tour.md): seven coach cards, each pointing at a real element.
// Each step names its screen and its element. Next and Back open that screen first; until the element is found,
// and when there is none (no locked test for an account that owns everything), the step shows as a docked card
// without a ring. From step 1 to Finish or Skip some tour card with the counter is always on screen.

type Step = {
  title: keyof Strings;
  body: keyof Strings;
  /** the screen the step lives on */
  on: (path: string) => boolean;
  /** CSS selectors, first one found wins; the second item is the ancestor to ring instead (closest) */
  anchors: (wide: boolean) => [string, string?][];
};
const id = (testID: string): [string] => [`[data-testid="${testID}"]`];
const home = (path: string) => path === '/';
const STEPS: Step[] = [
  { title: 'tour1Title', body: 'tour1Body', on: home, anchors: () => [id('subject-title')] },
  { title: 'tour2Title', body: 'tour2Body', on: home, anchors: () => [id('start-next')] },
  // on the learner's own checked answer, in any practice test
  { title: 'tour3Title', body: 'tour3Body', on: (p) => p.endsWith('/practice'), anchors: (wide) => (wide ? [id('explanation'), id('next')] : [id('next')]) },
  { title: 'tour4Title', body: 'tour4Body', on: home, anchors: (wide) => [id(wide ? 'home-review' : 'tab-review')] },
  { title: 'tour5Title', body: 'tour5Body', on: home, anchors: (wide) => [id(wide ? 'nav-progress' : 'tab-progress')] },
  { title: 'tour6Title', body: Platform.OS === 'web' ? 'tour6BodyWeb' : 'tour6BodyApp', on: home, anchors: () => [['[data-testid="locked-tag"]', '[role=link]'], ['[data-testid="test-group"] [role=link]']] }, // nothing locked: any test
  { title: 'tour7Title', body: 'tour7Body', on: (p) => p === '/profile', anchors: () => [id('profile-reminders')] },
];
const LAST = STEPS.length;

// One small store: the layer in the frame draws it, onboarding and Profile start it, Home tells it which test step 2 opens.
type State = { step?: number; prompt?: boolean };
let state: State = {};
let userKey = '';
const listeners = new Set<() => void>();
const set = (next: State, save = true) => {
  state = next;
  if (save && userKey) AsyncStorage.setItem(userKey, next.step ? String(next.step) : 'done');
  listeners.forEach((l) => l());
};
let sample: string | undefined;
let lastPath = '/'; // the open screen, for the resume decision after a reload
export const tour = {
  /** from step 1: after onboarding, and from Profile's "How it works" */
  start: () => set({ step: 1 }),
  /** the practice test step 2 opens; Home sets it for the current subject */
  setSample: (route: string | undefined) => {
    sample = route;
  },
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** True while a tour is running: phone screens leave room at the bottom for the docked tour bar. */
export function useTourRunning() {
  const { step, prompt } = useSyncExternalStore(subscribe, () => state, () => state);
  return !!step && !prompt;
}

type Box = { x: number; y: number; w: number; h: number };
const CARD = 340;

/** Draws the current step over everything. Rendered once, by the frame. */
export function TourLayer() {
  const c = useTheme();
  const sh = useShadow();
  const { t } = useI18n();
  const { step, prompt } = useSyncExternalStore(subscribe, () => state, () => state);
  const userId = useAuth().session?.user.id;
  const path = usePathname();
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  const wide = Platform.OS === 'web' && window.width >= 1024;
  const [cardH, setCardH] = useState(260); // measured once the card is drawn
  const [found, setFound] = useState<{ step: number; path: string; box: Box } | null>(null);
  const box = found && found.step === step && found.path === path ? found.box : null;
  useEffect(() => {
    lastPath = path;
  }, [path]);
  // While the learner does a step themselves (answering a question) the tour stays on screen as a small
  // docked card that blocks nothing: what to do now, and a ring on it.
  const [doing, setDoing] = useState<{ key: string; hint: 'pick' | 'check'; box: Box | null; floor: number } | null>(null);
  const [busy, setBusy] = useState(false); // a dialog is open: the tour steps aside

  // where this account left the tour on this device: a step to resume asks first, 'done' stays quiet
  useEffect(() => {
    userKey = userId ? `tour:${userId}` : '';
    if (!userId) return set({}, false);
    AsyncStorage.getItem(userKey).then((saved) => {
      const n = Number(saved);
      // a reload on the step's own screen carries on at that step; anywhere else Home asks first
      if (!state.step) set(n >= 1 && n <= LAST ? { step: n, prompt: n > 1 && !STEPS[n - 1].on(lastPath) } : {}, false);
    });
  }, [userId]);

  const current = step ? STEPS[step - 1] : undefined;
  const here = !!current && current.on(path);

  const done = () => set({});
  const go = (by: 1 | -1) => {
    if (!step) return;
    const next = step + by;
    if (next > LAST) return done();
    if (next < 1) return;
    set({ step: next });
    visit(next);
  };
  // open the screen a step lives on, unless it is already open
  const visit = (n: number) => {
    if (STEPS[n - 1].on(path)) return;
    if (n === 3) {
      if (sample) router.push(sample as never);
    } else if (n === LAST) router.navigate('/profile');
    // Home from another tab is a tab switch; from a pushed screen (a test) the stack is dismissed
    else if (/^\/(profile|review|progress)$/.test(path)) router.navigate('/');
    else router.dismissTo('/');
  };

  // Find the step's element a few times a second: it may still be loading, scrolled away, or under a dialog.
  useEffect(() => {
    if (!current || prompt || !here || Platform.OS !== 'web') return; // native has no way to find an element by id: the card shows unanchored
    // where the tour last scrolled to; once the learner scrolls away themselves, it stops
    let nudged = { picked: '', top: -1 };
    const look = () => {
      if (openSheets.count > 0) return setFound(null); // never over a dialog
      for (const [selector, ancestor] of current.anchors(wide)) {
        const found = document.querySelector(selector);
        const el = found && ancestor ? found.closest(ancestor) : found;
        const r = el?.getBoundingClientRect();
        if (!el || !r || r.width < 1) continue;
        if (r.top < 0 || r.bottom > innerHeight) return el.scrollIntoView({ block: 'center' });
        return setFound((f) => (f && f.step === step && f.path === path && f.box.x === r.left && f.box.y === r.top && f.box.w === r.width && f.box.h === r.height ? f : { step: step!, path, box: { x: r.left, y: r.top, w: r.width, h: r.height } }));
      }
      setFound(null);
      // step 3 waits for the learner's own answer: point at the options, then at Check
      if (step === 3) {
        const picked = !!document.querySelector('[role=radio][aria-checked=true]');
        const r = document.querySelector(picked ? '[data-testid=check]' : '[role=radiogroup]')?.getBoundingClientRect();
        const b = r && r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
        // the phone bar sits just above the Check button, wherever this screen size puts it
        const floor = Math.round(document.querySelector('[data-testid=check]')?.getBoundingClientRect().top ?? 0);
        // a phone shows the docked bar above Check: scroll the options up so the bar never covers them
        const group = document.querySelector('[role=radiogroup]');
        const g = group?.getBoundingClientRect();
        const dockTop = document.querySelector('[data-testid=tour-dock]')?.getBoundingClientRect().top;
        if (!wide && group && g && dockTop && g.bottom > dockTop - 8) {
          let box: Element | null = group.parentElement;
          while (box && !(box.scrollHeight > box.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
          if (box && (nudged.picked !== `${picked}` || nudged.top === box.scrollTop)) {
            box.scrollBy(0, g.bottom - dockTop + 8);
            nudged = { picked: `${picked}`, top: box.scrollTop };
          }
        }
        const key = `${path}|${picked}|${floor}|${b ? [b.x, b.y, b.w, b.h].join() : ''}`;
        return setDoing((d) => (d && d.key === key ? d : { key, hint: picked ? 'check' : 'pick', box: b, floor }));
      }
      // nothing to point at on this screen: the step stays up as the docked card, without a ring
    };
    const first = setTimeout(look, 0);
    const timer = setInterval(look, 250);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, prompt, here, wide, path]);

  // dialogs are checked on their own clock: the docked card hides while one is open
  useEffect(() => {
    if (!step || prompt) return;
    const timer = setInterval(() => setBusy(openSheets.count > 0), 250);
    return () => clearInterval(timer);
  }, [step, prompt]);

  const native = Platform.OS !== 'web';
  // a box found for an earlier step or screen does not count: the step shows once its own element is found
  const showing = !!current && !prompt && here && (native ? openSheets.count === 0 : !!box);
  useKeys(showing ? { arrowright: () => go(1), enter: () => go(1), arrowleft: () => go(-1), escape: done } : {});

  if (prompt && step && path === '/') {
    return (
      <View style={[StyleSheet.absoluteFill, { zIndex: 1000, alignItems: 'center', justifyContent: 'flex-end', padding: space.lg }]} pointerEvents="box-none">
        <View testID="tour-resume" accessibilityRole="alert" style={{ width: '100%', maxWidth: CARD, backgroundColor: c.surfaceRaised, borderRadius: radii.lg, borderWidth: 1, borderColor: c.border, padding: space.lg, gap: space.md, ...elevation.e3 }}>
          <Txt variant="bodyStrong">{`${t('tourResume')} ${step} / ${LAST}`}</Txt>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
            <Button title={t('notNow')} testID="tour-not-now" variant="ghost" size="sm" onPress={done} />
            <Button title={t('continue')} testID="tour-continue" size="sm" onPress={() => {
              set({ step });
              visit(step);
            }} />
          </View>
        </View>
      </View>
    );
  }
  if (!current || !step || prompt) return null;

  // Not a blocking step right now: either the learner is doing step 3 themselves, or they are on another
  // screen than the step's. The tour stays visible as a small card in a corner; the page is fully usable.
  if (!showing) {
    if (busy) return null;
    const act = here && step === 3 ? (doing && doing.key.startsWith(`${path}|`) ? doing : null) : null;
    const r = act?.box;
    // step 3 tells what to do now; a step on its own screen with nothing to point at keeps its full text
    const own = here && step !== 3;
    const text = own ? t(current.title) : here ? t(act?.hint === 'check' ? 'tourDoCheck' : 'tourDoPick') : t('tourDoReturn');
    return (
      <View style={[StyleSheet.absoluteFill, { zIndex: 1000 }]} pointerEvents="box-none">
        {r && (
          <View
            testID="tour-ring"
            pointerEvents="none"
            style={[
              { position: 'absolute', left: Math.max(2, r.x - 4), top: Math.max(2, r.y - 4), width: Math.min(window.width - 4, r.w + 8), height: r.h + 8, borderRadius: 22, borderWidth: 3, borderColor: c.apricot },
              !reduced && ({ transitionProperty: 'left, top, width, height', transitionDuration: '240ms' } as object),
            ]}
          />
        )}
        <View
          testID="tour-dock"
          accessibilityRole="alert"
          accessibilityLabel={`${t('stepOf', { i: step, n: LAST })}. ${text}`}
          // desktop: bottom right, clear of the question and the answer column; phone: a slim bar above the bottom button
          style={[
            { position: 'absolute', backgroundColor: c.surface, borderRadius: 18, boxShadow: sh.float, borderWidth: 2, borderColor: c.apricot, paddingVertical: space.sm, paddingHorizontal: space.md, gap: space.xs },
            wide ? { right: 24, bottom: 24, width: CARD } : { left: 12, right: 12, bottom: act && act.floor > window.height / 2 ? window.height - act.floor + 12 : 92 },
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Txt variant="meta" digits color="textMuted">{`${step} / ${LAST}`}</Txt>
            <View aria-hidden style={{ flex: 1, flexDirection: 'row', gap: 4 }}>
              {STEPS.map((_, i) => <View key={i} style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: i + 1 === step ? c.primary : c.track }, i + 1 === step && { width: 20 }]} />)}
            </View>
            {step > 1 && <Button title={t('back')} testID="tour-back" variant="ghost" size="sm" onPress={() => go(-1)} />}
            <Button title={t('tourSkip')} testID="tour-skip" variant="ghost" size="sm" onPress={done} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <Txt testID="tour-dock-text" style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 15, lineHeight: 21 }}>{text}</Txt>
            {!here && <Button title={t('continue')} testID="tour-next" size="sm" onPress={() => visit(step)} />}
          </View>
          {own && (
            <>
              <Txt variant="label" color="textMuted" style={{ fontFamily: fonts.regular }}>{t(current.body)}</Txt>
              <Button title={step === LAST ? t('tourGotIt') : t('next')} testID="tour-next" size="sm" onPress={() => go(1)} containerStyle={{ alignSelf: 'flex-end' }} />
            </>
          )}
        </View>
      </View>
    );
  }

  const pad = 6;
  // the ring sits a little outside its element, but never outside the window
  const edge = (from: number, size: number, max: number) => {
    const a = Math.max(2, from - pad);
    return [a, Math.min(max - 2, from + size + pad) - a];
  };
  const [hx, hw] = box ? edge(box.x, box.w, window.width) : [0, 0];
  const [hy, hh] = box ? edge(box.y, box.h, window.height) : [0, 0];
  const hole = box && { left: hx, top: hy, width: hw, height: hh };
  // The card goes under its element, else over it, else beside it, and is always wholly inside the window.
  // Centred when there is no element (native).
  const gap = 12;
  const margin = space.sm;
  const clamp = (v: number, max: number) => Math.max(margin, Math.min(v, max - margin));
  const cardW = Math.min(CARD, window.width - 2 * space.lg);
  const place = () => {
    if (!hole) return undefined;
    const centredX = clamp(hole.left + hole.width / 2 - cardW / 2, window.width - cardW);
    const under = hole.top + hole.height + gap;
    if (under + cardH + margin <= window.height) return { left: centredX, top: under };
    const over = hole.top - gap - cardH;
    if (over >= margin) return { left: centredX, top: over };
    const centredY = clamp(hole.top + hole.height / 2 - cardH / 2, window.height - cardH);
    const leftOf = hole.left - gap - cardW;
    if (leftOf >= margin) return { left: leftOf, top: centredY };
    const rightOf = hole.left + hole.width + gap;
    if (rightOf + cardW + margin <= window.width) return { left: rightOf, top: centredY };
    return { left: centredX, top: clamp(under, window.height - cardH) }; // no free side: stay inside the window
  };
  const at = place();
  const label = `${t('stepOf', { i: step, n: LAST })}. ${t(current.title)}. ${t(current.body)}`;

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 1000 }]} pointerEvents="box-none">
      {/* nothing under the tour can be pressed or scrolled while a step is open */}
      <Pressable aria-hidden tabIndex={-1} style={[StyleSheet.absoluteFill, { cursor: 'default' } as object, !hole && { backgroundColor: 'rgba(19, 23, 34, 0.62)' }]} />
      {hole && (
        <View
          testID="tour-ring"
          pointerEvents="none"
          style={[
            { position: 'absolute', borderRadius: radii.md, borderWidth: 3, borderColor: c.apricot, boxShadow: '0 0 0 9999px rgba(19, 23, 34, 0.62)' },
            hole,
            !reduced && ({ transitionProperty: 'left, top, width, height', transitionDuration: '240ms' } as object),
          ]}
        />
      )}
      <View
        testID="tour-card"
        role="dialog"
        aria-label={label}
        onLayout={(e) => setCardH(e.nativeEvent.layout.height)}
        style={[
          { position: 'absolute', width: cardW, backgroundColor: c.surface, borderRadius: radii.lg, padding: space.xl, gap: space.sm, boxShadow: sh.float },
          at ?? { alignSelf: 'center', top: '30%' },
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
          <Txt variant="meta" digits color="textMuted">{`${step} / ${LAST}`}</Txt>
          <Button title={t('tourSkip')} testID="tour-skip" variant="ghost" size="sm" onPress={done} />
        </View>
        <Txt variant="title3">{t(current.title)}</Txt>
        <Txt color="textMuted">{t(current.body)}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs }}>
          <View aria-hidden style={{ flex: 1, flexDirection: 'row', gap: 4 }}>
            {STEPS.map((_, i) => <View key={i} style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: i + 1 === step ? c.primary : c.track }, i + 1 === step && { width: 20 }]} />)}
          </View>
          {step > 1 && <Button title={t('back')} testID="tour-back" variant="ghost" size="sm" onPress={() => go(-1)} />}
          <Button title={step === LAST ? t('tourGotIt') : t('next')} testID="tour-next" size="sm" onPress={() => go(1)} />
        </View>
      </View>
    </View>
  );
}

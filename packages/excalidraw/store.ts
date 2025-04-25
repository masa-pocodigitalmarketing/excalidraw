import {
  arrayToMap,
  assertNever,
  isDevEnv,
  isTestEnv,
  randomId,
} from "@excalidraw/common";

import { hashElementsVersion } from "@excalidraw/element";
import { deepCopyElement } from "@excalidraw/element/duplicate";
import { newElementWith } from "@excalidraw/element/mutateElement";
import { syncMovedIndices } from "@excalidraw/element/fractionalIndex";

import { ElementsDelta, AppStateDelta, Delta } from "@excalidraw/element/delta";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
  SceneElementsMap,
} from "@excalidraw/element/types";

import type { DTO, ValueOf } from "@excalidraw/common/utility-types";

import { getDefaultAppState } from "./appState";

import { Emitter } from "./emitter";

import type { AppState, ObservedAppState } from "./types";

// hidden non-enumerable property for runtime checks
const hiddenObservedAppStateProp = "__observedAppState";

export const getObservedAppState = (appState: AppState): ObservedAppState => {
  const observedAppState = {
    name: appState.name,
    editingGroupId: appState.editingGroupId,
    viewBackgroundColor: appState.viewBackgroundColor,
    selectedElementIds: appState.selectedElementIds,
    selectedGroupIds: appState.selectedGroupIds,
    editingLinearElementId: appState.editingLinearElement?.elementId || null,
    selectedLinearElementId: appState.selectedLinearElement?.elementId || null,
    croppingElementId: appState.croppingElementId,
  };

  Reflect.defineProperty(observedAppState, hiddenObservedAppStateProp, {
    value: true,
    enumerable: false,
  });

  return observedAppState;
};

const isObservedAppState = (
  appState: AppState | ObservedAppState,
): appState is ObservedAppState =>
  !!Reflect.get(appState, hiddenObservedAppStateProp);

export const CaptureUpdateAction = {
  /**
   * Immediately undoable.
   *
   * Use for updates which should be captured.
   * Should be used for most of the local updates, except ephemerals such as dragging or resizing.
   *
   * These updates will _immediately_ make it to the local undo / redo stacks.
   */
  IMMEDIATELY: "IMMEDIATELY",
  /**
   * Never undoable.
   *
   * Use for updates which should never be recorded, such as remote updates
   * or scene initialization.
   *
   * These updates will _never_ make it to the local undo / redo stacks.
   */
  NEVER: "NEVER",
  /**
   * Eventually undoable.
   *
   * Use for updates which should not be captured immediately - likely
   * exceptions which are part of some async multi-step process. Otherwise, all
   * such updates would end up being captured with the next
   * `CaptureUpdateAction.IMMEDIATELY` - triggered either by the next `updateScene`
   * or internally by the editor.
   *
   * These updates will _eventually_ make it to the local undo / redo stacks.
   */
  EVENTUALLY: "EVENTUALLY",
} as const;

export type CaptureUpdateActionType = ValueOf<typeof CaptureUpdateAction>;

type MicroActionsQueue = (() => void)[];

/**
 * Store which captures the observed changes and emits them as `StoreIncrement` events.
 */
export class Store {
  public readonly onStoreIncrementEmitter = new Emitter<
    [DurableIncrement | EphemeralIncrement]
  >();

  private scheduledMacroActions: Set<CaptureUpdateActionType> = new Set();
  private scheduledMicroActions: MicroActionsQueue = [];

  private _snapshot = StoreSnapshot.empty();

  public get snapshot() {
    return this._snapshot;
  }

  public set snapshot(snapshot: StoreSnapshot) {
    this._snapshot = snapshot;
  }

  public scheduleAction(action: CaptureUpdateActionType) {
    this.scheduledMacroActions.add(action);
    this.satisfiesScheduledActionsInvariant();
  }

  /**
   * Use to schedule a delta calculation, which will consquentially be emitted as `DurableStoreIncrement` and pushed in the undo stack.
   */
  // TODO: Suspicious that this is called so many places. Seems error-prone.
  public scheduleCapture() {
    this.scheduleAction(CaptureUpdateAction.IMMEDIATELY);
  }

  /**
   * Schedule special "micro" actions, to-be executed before the next commit, before it executes a scheduled "macro" action.
   */
  public scheduleMicroAction(
    action: CaptureUpdateActionType,
    elements: Map<string, OrderedExcalidrawElement> | undefined,
    appState: AppState | ObservedAppState | undefined = undefined,
    /** delta is only relevant for `CaptureUpdateAction.IMMEDIATELY`, as it's the only action producing `DurableStoreIncrement` containing a delta */
    delta: StoreDelta | undefined = undefined,
  ) {
    // create a snapshot first, so that it couldn't mutate in the meantime
    const snapshot = this.maybeCloneSnapshot(elements, appState);

    if (!snapshot) {
      return;
    }

    this.scheduledMicroActions.push(() =>
      this.executeAction(action, snapshot, delta),
    );
  }

  /**
   * Performs the incoming `CaptureUpdateAction` and emits the corresponding `StoreIncrement`.
   * Emits `DurableStoreIncrement` when action is "capture", emits `EphemeralStoreIncrement` otherwise.
   *
   * @emits StoreIncrement
   */
  public commit(
    elements: Map<string, OrderedExcalidrawElement> | undefined,
    appState: AppState | ObservedAppState | undefined,
  ): void {
    // execute all scheduled micro actions first
    // similar to microTasks, there can be many
    this.flushMicroActions();

    try {
      const macroAction = this.getScheduledMacroAction();
      const nextSnapshot = this.maybeCloneSnapshot(elements, appState);

      if (!nextSnapshot) {
        // don't continue if there is not change detected
        return;
      }

      // execute a single scheduled "macro" function
      // similar to macro tasks, there can be only one within a single commit
      this.executeAction(macroAction, nextSnapshot);
    } finally {
      this.satisfiesScheduledActionsInvariant();
      // defensively reset all scheduled "macro" actions, possibly cleans up other runtime garbage
      this.scheduledMacroActions = new Set();
    }
  }

  /**
   * Apply the increment to the passed elements and appState, does not modify the snapshot.
   */
  public applyDeltaTo(
    delta: StoreDelta,
    elements: SceneElementsMap,
    appState: AppState,
  ): [SceneElementsMap, AppState, boolean] {
    const [nextElements, elementsContainVisibleChange] = delta.elements.applyTo(
      elements,
      this.snapshot.elements,
    );

    const [nextAppState, appStateContainsVisibleChange] =
      delta.appState.applyTo(appState, nextElements);

    const appliedVisibleChanges =
      elementsContainVisibleChange || appStateContainsVisibleChange;

    return [nextElements, nextAppState, appliedVisibleChanges];
  }

  /**
   * Filters out yet uncomitted elements from `nextElements`, which are part of in-progress local async actions (ephemerals) and thus were not yet commited to the snapshot.
   *
   * This is necessary in updates in which we receive reconciled elements, already containing elements which were not yet captured by the local store (i.e. collab).
   */
  public filterUncomittedElements(
    prevElements: Map<string, ExcalidrawElement>,
    nextElements: Map<string, ExcalidrawElement>,
  ): Map<string, OrderedExcalidrawElement> {
    const movedElements = new Map<string, ExcalidrawElement>();

    for (const [id, prevElement] of prevElements.entries()) {
      const nextElement = nextElements.get(id);

      if (!nextElement) {
        // Nothing to care about here, element was forcefully deleted
        continue;
      }

      const elementSnapshot = this.snapshot.elements.get(id);

      // Checks for in progress async user action
      if (!elementSnapshot) {
        // Detected yet uncomitted local element
        nextElements.delete(id);
      } else if (elementSnapshot.version < prevElement.version) {
        // Element was already commited, but the snapshot version is lower than current local version
        nextElements.set(id, elementSnapshot);
        // Mark the element as potentially moved, as it could have
        movedElements.set(id, elementSnapshot);
      }
    }

    // Make sure to sync only potentially invalid indices for all elements restored from the snapshot
    const syncedElements = syncMovedIndices(
      Array.from(nextElements.values()),
      movedElements,
    );

    return arrayToMap(syncedElements);
  }
  /**
   * Clears the store instance.
   */
  public clear(): void {
    this.snapshot = StoreSnapshot.empty();
    this.scheduledMacroActions = new Set();
  }

  /**
   * Executes the incoming `CaptureUpdateAction`, emits the corresponding `StoreIncrement` and maybe updates the snapshot.
   *
   * @emits StoreIncrement
   */
  private executeAction(
    action: CaptureUpdateActionType,
    snapshot: StoreSnapshot,
    delta: StoreDelta | undefined = undefined,
  ) {
    try {
      switch (action) {
        // only immediately emits a durable increment
        case CaptureUpdateAction.IMMEDIATELY:
          this.emitDurableIncrement(snapshot, delta);
          break;
        // both never and eventually emit an ephemeral increment
        case CaptureUpdateAction.NEVER:
        case CaptureUpdateAction.EVENTUALLY:
          this.emitEphemeralIncrement(snapshot);
          break;
        default:
          assertNever(action, `Unknown store action`);
      }
    } finally {
      // update the snpashot no-matter what, as it would mess up with the next action
      switch (action) {
        // both immediately and never update the snapshot, unlike eventually
        case CaptureUpdateAction.IMMEDIATELY:
        case CaptureUpdateAction.NEVER:
          this.snapshot = snapshot;
          break;
      }
    }
  }

  /**
   * Performs delta & change calculation and emits a durable increment.
   *
   * @emits StoreIncrement.
   */
  private emitDurableIncrement(
    snapshot: StoreSnapshot,
    delta: StoreDelta | undefined = undefined,
  ) {
    const prevSnapshot = this.snapshot;

    // Calculate the deltas based on the previous and next snapshot
    // We might have the delta already (i.e. when applying history entry), thus we don't need to calculate it again
    const elementsDelta = delta
      ? delta.elements
      : snapshot.metadata.didElementsChange
      ? ElementsDelta.calculate(prevSnapshot.elements, snapshot.elements)
      : ElementsDelta.empty();

    const appStateDelta = delta
      ? delta.appState
      : snapshot.metadata.didAppStateChange
      ? AppStateDelta.calculate(prevSnapshot.appState, snapshot.appState)
      : AppStateDelta.empty();

    if (!elementsDelta.isEmpty() || !appStateDelta.isEmpty()) {
      const delta = StoreDelta.create(elementsDelta, appStateDelta);
      const change = StoreChange.create(prevSnapshot, snapshot);
      const increment = new DurableIncrement(change, delta);

      // Notify listeners with the increment
      this.onStoreIncrementEmitter.trigger(increment);
    }
  }

  /**
   * Performs change calculation and emits an ephemeral increment.
   *
   * @emits EphemeralStoreIncrement
   */
  private emitEphemeralIncrement(snapshot: StoreSnapshot) {
    const prevSnapshot = this.snapshot;
    const change = StoreChange.create(prevSnapshot, snapshot);
    const increment = new EphemeralIncrement(change);

    // Notify listeners with the increment
    this.onStoreIncrementEmitter.trigger(increment);
  }

  /**
   * Clones the snapshot if there are changes detected.
   */
  private maybeCloneSnapshot(
    elements: Map<string, OrderedExcalidrawElement> | undefined,
    appState: AppState | ObservedAppState | undefined,
  ) {
    if (!elements && !appState) {
      return null;
    }

    const prevSnapshot = this.snapshot;
    const nextSnapshot = this.snapshot.maybeClone(elements, appState);

    if (prevSnapshot === nextSnapshot) {
      return null;
    }

    return nextSnapshot;
  }

  private flushMicroActions() {
    const microActions = [...this.scheduledMicroActions];

    // clear the queue first, in case it mutates in the meantime
    this.scheduledMicroActions = [];

    for (const microAction of microActions) {
      try {
        microAction();
      } catch (error) {
        console.error(`Failed to execute scheduled micro action`, error);
      }
    }
  }

  /**
   * Returns the scheduled macro action.
   */
  private getScheduledMacroAction() {
    let scheduledAction: CaptureUpdateActionType;

    if (this.scheduledMacroActions.has(CaptureUpdateAction.IMMEDIATELY)) {
      // Capture has a precedence over update, since it also performs snapshot update
      scheduledAction = CaptureUpdateAction.IMMEDIATELY;
    } else if (this.scheduledMacroActions.has(CaptureUpdateAction.NEVER)) {
      // Update has a precedence over none, since it also emits an (ephemeral) increment
      scheduledAction = CaptureUpdateAction.NEVER;
    } else {
      // Default is to emit ephemeral increment and don't update the snapshot
      scheduledAction = CaptureUpdateAction.EVENTUALLY;
    }

    return scheduledAction;
  }

  /**
   * Ensures that the scheduled actions invariant is satisfied.
   */
  private satisfiesScheduledActionsInvariant() {
    if (
      !(
        this.scheduledMacroActions.size >= 0 &&
        this.scheduledMacroActions.size <=
          Object.keys(CaptureUpdateAction).length
      )
    ) {
      const message = `There can be at most three store actions scheduled at the same time, but there are "${this.scheduledMacroActions.size}".`;
      console.error(message, this.scheduledMacroActions.values());

      if (isTestEnv() || isDevEnv()) {
        throw new Error(message);
      }
    }
  }
}

/**
 * Repsents a change to the store containg changed elements and appState.
 */
export class StoreChange {
  // TODO_I: consider adding (observed & syncable) appState, though bare in mind that it's processed on every component update,
  // so figuring out what has changed should ideally be just quick reference checks
  private constructor(
    public readonly elements: Record<string, OrderedExcalidrawElement>,
  ) {}

  public static create(
    prevSnapshot: StoreSnapshot,
    nextSnapshot: StoreSnapshot,
  ) {
    const changedElements = nextSnapshot.getChangedElements(prevSnapshot);
    return new StoreChange(changedElements);
  }
}

/**
 * Encpasulates any change to the store (durable or ephemeral).
 */
export abstract class StoreIncrement {
  protected constructor(
    public readonly type: "durable" | "ephemeral",
    public readonly change: StoreChange,
  ) {}

  public static isDurable(
    increment: StoreIncrement,
  ): increment is DurableIncrement {
    return increment.type === "durable";
  }

  public static isEphemeral(
    increment: StoreIncrement,
  ): increment is EphemeralIncrement {
    return increment.type === "ephemeral";
  }
}

/**
 * Represents a durable change to the store.
 */
export class DurableIncrement extends StoreIncrement {
  constructor(
    public readonly change: StoreChange,
    public readonly delta: StoreDelta,
  ) {
    super("durable", change);
  }
}

/**
 * Represents an ephemeral change to the store.
 */
export class EphemeralIncrement extends StoreIncrement {
  constructor(public readonly change: StoreChange) {
    super("ephemeral", change);
  }
}

/**
 * Represents a captured delta by the Store.
 */
export class StoreDelta {
  protected constructor(
    public readonly id: string,
    public readonly elements: ElementsDelta,
    public readonly appState: AppStateDelta,
  ) {}

  /**
   * Create a new instance of `StoreDelta`.
   */
  public static create(
    elements: ElementsDelta,
    appState: AppStateDelta,
    opts: {
      id: string;
    } = {
      id: randomId(),
    },
  ) {
    return new this(opts.id, elements, appState);
  }

  /**
   * Restore a store delta instance from a DTO.
   */
  public static restore(storeDeltaDTO: DTO<StoreDelta>) {
    const { id, elements, appState } = storeDeltaDTO;
    return new this(
      id,
      ElementsDelta.restore(elements),
      AppStateDelta.restore(appState),
    );
  }

  /**
   * Parse and load the delta from the remote payload.
   */
  public static load({
    id,
    elements: { added, removed, updated },
  }: DTO<StoreDelta>) {
    const elements = ElementsDelta.create(added, removed, updated, {
      shouldRedistribute: false,
    });

    return new this(id, elements, AppStateDelta.empty());
  }

  /**
   * Inverse store delta, creates new instance of `StoreDelta`.
   */
  public static inverse(delta: StoreDelta): StoreDelta {
    return this.create(delta.elements.inverse(), delta.appState.inverse());
  }

  /**
   * Apply latest (remote) changes to the delta, creates new instance of `StoreDelta`.
   */
  public static applyLatestChanges(
    delta: StoreDelta,
    elements: SceneElementsMap,
    modifierOptions: "deleted" | "inserted",
  ): StoreDelta {
    return this.create(
      delta.elements.applyLatestChanges(elements, modifierOptions),
      delta.appState,
      {
        id: delta.id,
      },
    );
  }

  public isEmpty() {
    return this.elements.isEmpty() && this.appState.isEmpty();
  }
}

/**
 * Represents a snapshot of the captured or updated changes in the store,
 * used for producing deltas and emitting `DurableStoreIncrement`s.
 */
export class StoreSnapshot {
  private _lastChangedElementsHash: number = 0;

  private constructor(
    public readonly elements: Map<string, OrderedExcalidrawElement>,
    public readonly appState: ObservedAppState,
    public readonly metadata: {
      didElementsChange: boolean;
      didAppStateChange: boolean;
      isEmpty?: boolean;
    } = {
      didElementsChange: false,
      didAppStateChange: false,
      isEmpty: false,
    },
  ) {}

  public static empty() {
    return new StoreSnapshot(
      new Map(),
      getObservedAppState(getDefaultAppState() as AppState),
      { didElementsChange: false, didAppStateChange: false, isEmpty: true },
    );
  }

  public getChangedElements(prevSnapshot: StoreSnapshot) {
    const changedElements: Record<string, OrderedExcalidrawElement> = {};

    for (const [id, nextElement] of this.elements.entries()) {
      // Due to the structural clone inside `maybeClone`, we can perform just these reference checks
      if (prevSnapshot.elements.get(id) !== nextElement) {
        changedElements[id] = nextElement;
      }
    }

    return changedElements;
  }

  public getChangedAppState(
    prevSnapshot: StoreSnapshot,
  ): Partial<ObservedAppState> {
    return Delta.getRightDifferences(
      prevSnapshot.appState,
      this.appState,
    ).reduce(
      (acc, key) =>
        Object.assign(acc, {
          [key]: this.appState[key as keyof ObservedAppState],
        }),
      {} as Partial<ObservedAppState>,
    );
  }

  public isEmpty() {
    return this.metadata.isEmpty;
  }

  /**
   * Efficiently clone the existing snapshot, only if we detected changes.
   *
   * @returns same instance if there are no changes detected, new instance otherwise.
   */
  public maybeClone(
    elements: Map<string, OrderedExcalidrawElement> | undefined,
    appState: AppState | ObservedAppState | undefined,
    options: {
      shouldIgnoreCache: boolean;
    } = {
      shouldIgnoreCache: false,
    },
  ) {
    const nextElementsSnapshot = this.maybeCreateElementsSnapshot(
      elements,
      options,
    );
    const nextAppStateSnapshot = this.maybeCreateAppStateSnapshot(appState);

    let didElementsChange = false;
    let didAppStateChange = false;

    if (this.elements !== nextElementsSnapshot) {
      didElementsChange = true;
    }

    if (this.appState !== nextAppStateSnapshot) {
      didAppStateChange = true;
    }

    if (!didElementsChange && !didAppStateChange) {
      return this;
    }

    const snapshot = new StoreSnapshot(
      nextElementsSnapshot,
      nextAppStateSnapshot,
      {
        didElementsChange,
        didAppStateChange,
      },
    );

    return snapshot;
  }

  private maybeCreateAppStateSnapshot(
    appState: AppState | ObservedAppState | undefined,
  ) {
    if (!appState) {
      return this.appState;
    }

    // Not watching over everything from the app state, just the relevant props
    const nextAppStateSnapshot = !isObservedAppState(appState)
      ? getObservedAppState(appState)
      : appState;

    const didAppStateChange = this.detectChangedAppState(nextAppStateSnapshot);

    if (!didAppStateChange) {
      return this.appState;
    }

    return nextAppStateSnapshot;
  }

  private detectChangedAppState(nextObservedAppState: ObservedAppState) {
    // TODO_I: could we optimize by checking only reference changes? (i.e. selectedElementIds should be stable now); this is not used for now
    return Delta.isRightDifferent(this.appState, nextObservedAppState);
  }

  private maybeCreateElementsSnapshot(
    elements: Map<string, OrderedExcalidrawElement> | undefined,
    options: {
      shouldIgnoreCache: boolean;
    } = {
      shouldIgnoreCache: false,
    },
  ) {
    if (!elements) {
      return this.elements;
    }

    const changedElements = this.detectChangedElements(elements, options);

    if (!changedElements?.size) {
      return this.elements;
    }

    const elementsSnapshot = this.createElementsSnapshot(changedElements);
    return elementsSnapshot;
  }

  /**
   * Detect if there any changed elements.
   *
   * NOTE: we shouldn't just use `sceneVersionNonce` instead, as we need to call this before the scene updates.
   */
  private detectChangedElements(
    nextElements: Map<string, OrderedExcalidrawElement>,
    options: {
      shouldIgnoreCache: boolean;
    } = {
      shouldIgnoreCache: false,
    },
  ) {
    if (this.elements === nextElements) {
      return;
    }

    const changedElements: Map<string, OrderedExcalidrawElement> = new Map();

    for (const [id, prevElement] of this.elements) {
      const nextElement = nextElements.get(id);

      if (!nextElement) {
        // element was deleted
        changedElements.set(
          id,
          newElementWith(prevElement, { isDeleted: true }),
        );
      }
    }

    for (const [id, nextElement] of nextElements) {
      const prevElement = this.elements.get(id);

      if (
        !prevElement || // element was added
        prevElement.version < nextElement.version // element was updated
      ) {
        changedElements.set(id, nextElement);
      }
    }

    if (!changedElements.size) {
      return;
    }

    // TODO I: parameter was removed, consider removing this completely
    // if we wouldn't ignore a cache, durable increment would be skipped
    // in case there was an ephemeral increment emitted just before
    // with the same changed elements
    if (options.shouldIgnoreCache) {
      return changedElements;
    }

    // due to snapshot containing only durable changes,
    // we might have already processed these elements in a previous run,
    // hence additionally check whether the hash of the elements has changed
    // since if it didn't, we don't need to process them again
    // otherwise we would have ephemeral increments even for component updates unrelated to elements
    const changedElementsHash = hashElementsVersion(
      Array.from(changedElements.values()),
    );

    if (this._lastChangedElementsHash === changedElementsHash) {
      return;
    }

    this._lastChangedElementsHash = changedElementsHash;
    return changedElements;
  }

  /**
   * Perform structural clone, deep cloning only elements that changed.
   */
  private createElementsSnapshot(
    changedElements: Map<string, OrderedExcalidrawElement>,
  ) {
    const clonedElements = new Map();

    for (const [id, prevElement] of this.elements) {
      // Clone previous elements, never delete, in case nextElements would be just a subset of previous elements
      // i.e. during collab, persist or whenenever isDeleted elements get cleared
      clonedElements.set(id, prevElement);
    }

    for (const [id, changedElement] of changedElements) {
      clonedElements.set(id, deepCopyElement(changedElement));
    }

    return clonedElements;
  }
}

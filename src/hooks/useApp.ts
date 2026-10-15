import { appStore, type AppState } from '../stores/appStore';
import { useStore } from '../stores/createStore';

export function useApp<S>(selector: (s: AppState) => S): S {
  return useStore(appStore, selector);
}

export function isInitialPanelLoad(loading: boolean, hasData: boolean) {
  return loading && !hasData;
}

export function isInPlaceRefresh(loading: boolean, refreshing: boolean, hasData: boolean) {
  return refreshing || (loading && hasData);
}

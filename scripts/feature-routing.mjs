export function classifyFeatureRoute(facts) {
  if (facts.changesOwnedBehavior === true) return "revise-existing";
  if (facts.independentlyToggleable === true || facts.distinctPermissions === true || facts.distinctUiOwner === true) return "create-new";
  if (facts.cohesiveWithExistingOwner === true) return "add-to-existing";
  return "ask-user";
}

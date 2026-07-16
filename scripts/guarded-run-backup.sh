#!/bin/sh
set -eu

umask 077

usage() {
  echo "usage: $0" >&2
  echo "optional overrides: GUARDED_RUN_APP_PATH, GUARDED_RUN_STATE_ROOT, GUARDED_RUN_WATCHER_PLIST, GUARDED_RUN_BACKUP_ROOT" >&2
}

warn() {
  echo "WARNING: $*" >&2
}

fail() {
  echo "FAILURE: $*" >&2
  exit 1
}

json_string() {
  value=$1
  escaped=$(printf '%s' "$value" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '"%s"' "$escaped"
}

json_array_from_file() {
  list_file=$1
  indent=$2
  first=1
  while IFS= read -r value || [ -n "$value" ]; do
    [ -n "$value" ] || continue
    if [ "$first" -eq 0 ]; then
      printf ',\n'
    fi
    printf '%s' "$indent"
    json_string "$value"
    first=0
  done < "$list_file"
}

copy_state_file() {
  relative_path=$1
  source_path=$state_root/$relative_path
  destination_path=$backup_dir/state/$relative_path

  if [ ! -f "$source_path" ]; then
    warn "state file is missing: $source_path"
    printf '%s\n' "$relative_path" >> "$missing_paths_file"
    return 0
  fi

  mkdir -p "${destination_path%/*}"
  if ditto --rsrc --extattr --qtn --acl "$source_path" "$destination_path"; then
    printf '%s\n' "$relative_path" >> "$captured_state_files_file"
    state_file_count=$((state_file_count + 1))
  else
    warn "could not copy state file: $source_path"
    printf '%s\n' "$relative_path" >> "$failed_copies_file"
    failure_count=$((failure_count + 1))
  fi
}

if [ "$#" -ne 0 ]; then
  usage
  exit 2
fi

home=${HOME:?HOME must be set}
app_path=${GUARDED_RUN_APP_PATH:-/Applications/ChatGPT.app}
state_root=${GUARDED_RUN_STATE_ROOT:-$home/Library/Application\ Support/codex-plusplus}
watcher_plist=${GUARDED_RUN_WATCHER_PLIST:-$home/Library/LaunchAgents/com.therealityreport.tweakers.watcher.plist}
backup_root=${GUARDED_RUN_BACKUP_ROOT:-$home/Library/Application\ Support/Tweakers/guarded-backups}

timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
mkdir -p "$backup_root"

backup_dir=$backup_root/$timestamp
suffix=0
while :; do
  if mkdir "$backup_dir" 2>/dev/null; then
    break
  fi
  if [ ! -e "$backup_dir" ]; then
    fail "could not create backup directory: $backup_dir"
  fi
  suffix=$((suffix + 1))
  backup_dir=$backup_root/${timestamp}-${suffix}
done

mkdir -p "$backup_dir/state" "$backup_dir/keychain"

captured_state_files_file=$backup_dir/.captured-state-files
skipped_transaction_apps_file=$backup_dir/.skipped-transaction-apps
missing_paths_file=$backup_dir/.missing-paths
failed_copies_file=$backup_dir/.failed-copies
transaction_candidates_file=$backup_dir/.transaction-candidates
: > "$captured_state_files_file"
: > "$skipped_transaction_apps_file"
: > "$missing_paths_file"
: > "$failed_copies_file"
: > "$transaction_candidates_file"

created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
failure_count=0
state_file_count=0

app_status=missing
app_capture_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
codesign_status=null
codesign_identity=
codesign_display_path=

if [ -d "$app_path" ]; then
  mkdir -p "$backup_dir/app"
  if ditto --rsrc --extattr --qtn --acl "$app_path" "$backup_dir/app/ChatGPT.app"; then
    app_status=captured
  else
    app_status=copy-failed
    warn "could not copy app with ditto: $app_path"
    printf '%s\n' "$app_path" >> "$failed_copies_file"
    failure_count=$((failure_count + 1))
  fi

  codesign_display_path=app/codesign-dv.txt
  if command -v codesign >/dev/null 2>&1; then
    if codesign -dv "$app_path" > "$backup_dir/$codesign_display_path" 2>&1; then
      codesign_status=0
    else
      codesign_status=$?
      warn "codesign -dv could not inspect: $app_path"
    fi
    codesign_identity=$(sed -n -e 's/^Authority=//p' -e 's/^Identifier=//p' "$backup_dir/$codesign_display_path" | head -n 1)
  else
    warn "codesign is unavailable; app identity was not recorded"
    : > "$backup_dir/$codesign_display_path"
    codesign_status=127
  fi
else
  warn "live app is missing; continuing without an app snapshot: $app_path"
  printf '%s\n' "$app_path" >> "$missing_paths_file"
fi

state_capture_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
state_status=missing
if [ -d "$state_root" ]; then
  state_status=present

  for relative_path in config.json state.json update-mode.json self-update-state.json refresh-state.json transactions/app-install.json; do
    copy_state_file "$relative_path"
  done

  transactions_root=$state_root/transactions
  if [ -d "$transactions_root" ]; then
    find "$transactions_root" -type d -name '*.app' -prune -print | sort > "$skipped_transaction_apps_file"
    find "$transactions_root" \
      \( -type d -name '*.app' -prune \) -o \
      \( -type f \( -name '*.json' -o -name '*.state' \) -print \) | sort > "$transaction_candidates_file"

    while IFS= read -r transaction_path || [ -n "$transaction_path" ]; do
      [ -n "$transaction_path" ] || continue
      relative_path=${transaction_path#"$state_root"/}
      if grep -Fqx "$relative_path" "$captured_state_files_file"; then
        continue
      fi
      copy_state_file "$relative_path"
    done < "$transaction_candidates_file"
  else
    warn "transaction directory is missing; continuing without transaction snapshots: $transactions_root"
    printf '%s\n' transactions/app-install.json >> "$missing_paths_file"
  fi
else
  warn "state root is missing; continuing without state snapshots: $state_root"
  printf '%s\n' "$state_root" >> "$missing_paths_file"
fi

watcher_capture_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
watcher_status=missing
watcher_backup_path=watcher/$(basename "$watcher_plist")
if [ -f "$watcher_plist" ]; then
  mkdir -p "$backup_dir/watcher"
  if ditto --rsrc --extattr --qtn --acl "$watcher_plist" "$backup_dir/$watcher_backup_path"; then
    watcher_status=captured
  else
    watcher_status=copy-failed
    warn "could not copy watcher plist: $watcher_plist"
    printf '%s\n' "$watcher_plist" >> "$failed_copies_file"
    failure_count=$((failure_count + 1))
  fi
else
  warn "watcher plist is missing; continuing without a watcher snapshot: $watcher_plist"
  printf '%s\n' "$watcher_plist" >> "$missing_paths_file"
fi

keychain_capture_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
trust_settings_path=keychain/dump-trust-settings.txt
codesigning_identities_path=keychain/codesigning-identities.txt
trust_settings_status=127
codesigning_identities_status=127
if command -v security >/dev/null 2>&1; then
  if security dump-trust-settings -d > "$backup_dir/$trust_settings_path" 2>&1; then
    trust_settings_status=0
  else
    trust_settings_status=$?
    warn "security dump-trust-settings -d returned $trust_settings_status; output was retained"
  fi
  if security find-identity -v -p codesigning > "$backup_dir/$codesigning_identities_path" 2>&1; then
    codesigning_identities_status=0
  else
    codesigning_identities_status=$?
    warn "security find-identity -v -p codesigning returned $codesigning_identities_status; output was retained"
  fi
else
  warn "security is unavailable; keychain snapshots were not captured"
  : > "$backup_dir/$trust_settings_path"
  : > "$backup_dir/$codesigning_identities_path"
fi

completed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
manifest_path=$backup_dir/manifest.json
{
  printf '{\n'
  printf '  "schema_version": 1,\n'
  printf '  "created_at": '; json_string "$created_at"; printf ',\n'
  printf '  "completed_at": '; json_string "$completed_at"; printf ',\n'
  printf '  "backup_dir": '; json_string "$backup_dir"; printf ',\n'
  printf '  "source_paths": {\n'
  printf '    "app": '; json_string "$app_path"; printf ',\n'
  printf '    "state_root": '; json_string "$state_root"; printf ',\n'
  printf '    "watcher_plist": '; json_string "$watcher_plist"; printf '\n'
  printf '  },\n'
  printf '  "captured": {\n'
  printf '    "app": {\n'
  printf '      "status": '; json_string "$app_status"; printf ',\n'
  printf '      "source_path": '; json_string "$app_path"; printf ',\n'
  printf '      "backup_path": '; json_string app/ChatGPT.app; printf ',\n'
  printf '      "captured_at": '; json_string "$app_capture_at"; printf ',\n'
  printf '      "codesign_dv_path": '; if [ -n "$codesign_display_path" ]; then json_string "$codesign_display_path"; else printf 'null'; fi; printf ',\n'
  printf '      "codesign_status": %s,\n' "$codesign_status"
  printf '      "codesign_identity": '; if [ -n "$codesign_identity" ]; then json_string "$codesign_identity"; else printf 'null'; fi; printf '\n'
  printf '    },\n'
  printf '    "state": {\n'
  printf '      "status": '; json_string "$state_status"; printf ',\n'
  printf '      "source_path": '; json_string "$state_root"; printf ',\n'
  printf '      "backup_path": '; json_string state; printf ',\n'
  printf '      "captured_at": '; json_string "$state_capture_at"; printf ',\n'
  printf '      "captured_file_count": %s\n' "$state_file_count"
  printf '    },\n'
  printf '    "watcher_plist": {\n'
  printf '      "status": '; json_string "$watcher_status"; printf ',\n'
  printf '      "source_path": '; json_string "$watcher_plist"; printf ',\n'
  printf '      "backup_path": '; json_string "$watcher_backup_path"; printf ',\n'
  printf '      "captured_at": '; json_string "$watcher_capture_at"; printf '\n'
  printf '    },\n'
  printf '    "keychain": {\n'
  printf '      "captured_at": '; json_string "$keychain_capture_at"; printf ',\n'
  printf '      "trust_settings_path": '; json_string "$trust_settings_path"; printf ',\n'
  printf '      "trust_settings_status": %s,\n' "$trust_settings_status"
  printf '      "codesigning_identities_path": '; json_string "$codesigning_identities_path"; printf ',\n'
  printf '      "codesigning_identities_status": %s\n' "$codesigning_identities_status"
  printf '    }\n'
  printf '  },\n'
  printf '  "state_files": [\n'
  json_array_from_file "$captured_state_files_file" '    '
  printf '\n  ],\n'
  printf '  "skipped_transaction_apps": [\n'
  json_array_from_file "$skipped_transaction_apps_file" '    '
  printf '\n  ],\n'
  printf '  "missing_paths": [\n'
  json_array_from_file "$missing_paths_file" '    '
  printf '\n  ],\n'
  printf '  "failed_copies": [\n'
  json_array_from_file "$failed_copies_file" '    '
  printf '\n  ]\n'
  printf '}\n'
} > "$manifest_path"

if [ "$failure_count" -eq 0 ]; then
  echo "GUARDED RUN BACKUP: SUCCESS: $backup_dir"
  exit 0
fi

echo "GUARDED RUN BACKUP: FAILURE: $backup_dir ($failure_count copy failure(s); manifest retained)" >&2
exit 1

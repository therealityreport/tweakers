#!/bin/sh
set -eu

umask 077

usage() {
  echo "usage: $0 <backup-dir>" >&2
  echo "optional overrides: GUARDED_RUN_APP_PATH, GUARDED_RUN_STATE_ROOT, GUARDED_RUN_WATCHER_PLIST" >&2
}

warn() {
  echo "WARNING: $*" >&2
}

fail() {
  echo "GUARDED RUN RESTORE: FAILURE: $*" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

home=${HOME:?HOME must be set}
backup_input=$1
if [ ! -d "$backup_input" ]; then
  fail "backup directory does not exist: $backup_input"
fi
backup_dir=$(cd "$backup_input" && pwd -P)
if [ ! -f "$backup_dir/manifest.json" ]; then
  fail "manifest.json is missing from backup directory: $backup_dir"
fi

app_path=${GUARDED_RUN_APP_PATH:-/Applications/ChatGPT.app}
state_root=${GUARDED_RUN_STATE_ROOT:-$home/Library/Application\ Support/tweaker}
watcher_plist=${GUARDED_RUN_WATCHER_PLIST:-$home/Library/LaunchAgents/com.therealityreport.tweakers.watcher.plist}

restore_failures=0

if [ -d "$backup_dir/app/ChatGPT.app" ]; then
  mkdir -p "${app_path%/*}"
  if ditto --rsrc --extattr --qtn --acl "$backup_dir/app/ChatGPT.app" "$app_path"; then
    :
  else
    warn "could not restore app with ditto: $app_path"
    restore_failures=$((restore_failures + 1))
  fi
else
  warn "app snapshot is missing; leaving the target app unchanged: $backup_dir/app/ChatGPT.app"
  restore_failures=$((restore_failures + 1))
fi

state_backup_root=$backup_dir/state
captured_state_files_file=$backup_dir/.captured-state-files
if [ -d "$state_backup_root" ] && [ -f "$captured_state_files_file" ]; then
  while IFS= read -r relative_path || [ -n "$relative_path" ]; do
    [ -n "$relative_path" ] || continue
    case "$relative_path" in
      /*|..|../*|*/../*)
        warn "unsafe state path in backup; skipping: $relative_path"
        restore_failures=$((restore_failures + 1))
        continue
        ;;
    esac
    source_path=$state_backup_root/$relative_path
    if [ ! -f "$source_path" ]; then
      warn "captured state file is missing from backup; leaving target unchanged: $source_path"
      restore_failures=$((restore_failures + 1))
      continue
    fi
    destination_path=$state_root/$relative_path
    mkdir -p "${destination_path%/*}"
    if ditto --rsrc --extattr --qtn --acl "$source_path" "$destination_path"; then
      :
    else
      warn "could not restore state file: $destination_path"
      restore_failures=$((restore_failures + 1))
    fi
  done < "$captured_state_files_file"
else
  warn "captured state file list or state snapshot directory is missing; leaving state unchanged: $backup_dir"
fi

watcher_backup_path=$backup_dir/watcher/$(basename "$watcher_plist")
if [ -f "$watcher_backup_path" ]; then
  mkdir -p "${watcher_plist%/*}"
  if ditto --rsrc --extattr --qtn --acl "$watcher_backup_path" "$watcher_plist"; then
    :
  else
    warn "could not restore watcher plist: $watcher_plist"
    restore_failures=$((restore_failures + 1))
  fi
else
  warn "watcher snapshot is missing; leaving watcher plist unchanged: $watcher_backup_path"
fi

if command -v codesign >/dev/null 2>&1 && [ -d "$app_path" ]; then
  if codesign --verify --deep --strict "$app_path"; then
    :
  else
    warn "codesign verification failed for restored app: $app_path"
    restore_failures=$((restore_failures + 1))
  fi
else
  warn "codesign is unavailable or the restored app is missing: $app_path"
  restore_failures=$((restore_failures + 1))
fi

if [ "$restore_failures" -eq 0 ]; then
  echo "GUARDED RUN RESTORE: SUCCESS: restored targets and codesign verification passed for $app_path"
  exit 0
fi

echo "GUARDED RUN RESTORE: FAILURE: $restore_failures restore/verification failure(s); target app: $app_path" >&2
exit 1

!macro NSIS_HOOK_PREINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "/D=" $R9
  ${If} $UpdateMode == 1
  ${AndIf} ${Errors}
    DetailPrint "Forcing current-user update directory to $LOCALAPPDATA\${PRODUCTNAME}"
    StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    SetOutPath "$INSTDIR"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION "Remove STS2 Mod Manager saved modpacks, settings, backups, logs, and cached downloads for this Windows account? This will not remove Slay the Spire 2 mods, Steam Workshop files, game saves, or developer-build data. Choose No to keep manager data for a future reinstall." IDNO done
  DetailPrint "Removing STS2 Mod Manager saved data"
  RMDir /r "$APPDATA\sts2-mod-manager"
  RMDir /r "$LOCALAPPDATA\sts2-mod-manager"
  done:
!macroend

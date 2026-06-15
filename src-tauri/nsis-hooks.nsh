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

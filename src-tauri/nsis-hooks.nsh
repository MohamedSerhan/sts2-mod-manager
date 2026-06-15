!macro NSIS_HOOK_PREINSTALL
  ${If} $UpdateMode == 1
    DetailPrint "Forcing current-user update directory to $LOCALAPPDATA\${PRODUCTNAME}"
    StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    SetOutPath "$INSTDIR"
  ${EndIf}
!macroend

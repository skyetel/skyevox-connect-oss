!macro customInstall
  CreateDirectory "$SMPROGRAMS\SkyeVox Connect"
  CreateShortCut "$SMPROGRAMS\SkyeVox Connect\SkyeVox Connect.lnk" "$INSTDIR\SkyeVox Connect.exe"
  CreateShortCut "$SMPROGRAMS\SkyeVox Connect\Uninstall SkyeVox Connect.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
  CreateShortCut "$DESKTOP\SkyeVox Connect.lnk" "$INSTDIR\SkyeVox Connect.exe"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\SkyeVox Connect\SkyeVox Connect.lnk"
  Delete "$SMPROGRAMS\SkyeVox Connect\Uninstall SkyeVox Connect.lnk"
  RMDir "$SMPROGRAMS\SkyeVox Connect"
  Delete "$DESKTOP\SkyeVox Connect.lnk"
!macroend

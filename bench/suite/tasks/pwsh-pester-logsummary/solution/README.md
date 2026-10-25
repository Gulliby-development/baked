# LogSummary

```powershell
. ./src/LogSummary.ps1
Get-Content app.log | Get-LogSummary -Since (Get-Date).AddHours(-1)
```

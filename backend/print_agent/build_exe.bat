@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Python 없는 PC에 배포할 단일 exe 생성 (필요: pip install pyinstaller pywin32 pillow)
set FONT=C:\Windows\Fonts\NotoSansKR-VF.ttf
pyinstaller --onefile --name print_agent --paths ..\services --add-data "%FONT%;." agent.py
echo.
echo dist\print_agent.exe 를 프린터가 있는 PC로 복사해서 실행하세요.
pause

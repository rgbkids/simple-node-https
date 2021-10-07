import VTeacher from './VTeacher.client';

export default function App({selectedId, isEditing, searchText, selectedTitle, selectedBody, userId, token, lang}) {
    return (
        <div className="main">
            <VTeacher />
        </div>
    );
}
